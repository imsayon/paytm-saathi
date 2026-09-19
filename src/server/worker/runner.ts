import { closeDb, getDb, newId, type Db } from "../db/client";
import { config } from "../config";
import { dispatchPendingEvents } from "../integrations/events";
import { log } from "../observability/log";
import { getDeliveryProvider } from "../providers";
import type { DeliveryProvider } from "../providers/types";
import { rewardPromise, type Proposal } from "../domain/rules";

export const MAX_ATTEMPTS = 2;
const LEASE_MS = 30_000;

type JobRow = {
  id: string;
  merchant_id: string;
  campaign_id: string;
  version_id: string;
  recipient_id: string;
  customer_id: string;
  status: string;
  provider_key: string;
  attempt_count: number;
  scenario_slot: number;
  /** Provider message id from the latest attempt that recorded one; what a status lookup needs. */
  last_provider_message_id: string | null;
} & SendContext;

export type DrainSummary = {
  processed: number;
  delivered: number;
  failed: number;
  unknown: number;
  needsReview: number;
  cancelled: number;
};

type SendContext = {
  current_version: number | null;
  version: number | null;
  approval_id: string | null;
  consent_state: string | null;
  contact_ref: string | null;
  proposal: Proposal | null;
};

/**
 * Atomic claim: the row lock with SKIP LOCKED means a second worker cannot take
 * a job whose lease is still live, and an expired lease becomes claimable again
 * after a crash. The same statement reads everything the pre-send check and the
 * send need (current version, active approval, latest consent, contact
 * reference, copy), so the check runs on data as fresh as the claim itself and
 * a job costs one round trip before the provider is asked anything.
 */
async function claimJob(db: Db, workerId: string): Promise<JobRow | null> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseExpiry = new Date(now + LEASE_MS).toISOString();

  const claimed = await db.one<JobRow>(
    `WITH candidate AS (
       SELECT id, status FROM delivery_job
        WHERE status = 'QUEUED'
           OR (status = 'UNKNOWN' AND attempt_count < $4)
           OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $5)
        ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE delivery_job j
        SET status = 'PROCESSING', lease_owner = $1, lease_expires_at = $2, updated_at = $3
       FROM candidate WHERE j.id = candidate.id
      RETURNING j.id, j.merchant_id, j.campaign_id, j.version_id, j.recipient_id, j.customer_id, candidate.status,
                j.provider_key, j.attempt_count, j.scenario_slot,
                (SELECT c.current_version FROM campaign c WHERE c.id = j.campaign_id) AS current_version,
                (SELECT v.version FROM campaign_version v WHERE v.id = j.version_id) AS version,
                (SELECT v.proposal FROM campaign_version v WHERE v.id = j.version_id) AS proposal,
                (SELECT cu.contact_ref FROM customer cu WHERE cu.id = j.customer_id) AS contact_ref,
                (SELECT a.id FROM campaign_approval a WHERE a.version_id = j.version_id AND a.status = 'active' LIMIT 1) AS approval_id,
                (SELECT cs.state FROM consent cs
                  WHERE cs.merchant_id = j.merchant_id AND cs.customer_id = j.customer_id
                    AND cs.purpose = 'merchant_reengagement'
                    AND (cs.expires_at IS NULL OR cs.expires_at > now())
                  ORDER BY cs.observed_at DESC, cs.seq DESC LIMIT 1) AS consent_state,
                (SELECT a.provider_message_id FROM delivery_attempt a
                  WHERE a.job_id = j.id AND a.provider_message_id IS NOT NULL
                  ORDER BY a.attempt_no DESC LIMIT 1) AS last_provider_message_id`,
    [workerId, leaseExpiry, nowIso, MAX_ATTEMPTS, nowIso],
  );
  return claimed ?? null;
}

/** Job update and audit event in one statement, so neither can land without the other. */
async function cancelJob(db: Db, job: JobRow, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `WITH job AS (
       UPDATE delivery_job
          SET status = 'CANCELLED', cancel_reason = $1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $2
        WHERE id = $3
     )
     INSERT INTO audit_event
       (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details, created_at)
     VALUES ($4, $5, $6, $7, $3, 'worker', 'delivery.cancelled', $8, NULL, 'CANCELLED', NULL, $9::jsonb, $2)`,
    [
      reason,
      now,
      job.id,
      newId("aud"),
      job.merchant_id,
      job.campaign_id,
      job.version_id,
      `delivery_job:${job.id}`,
      JSON.stringify({ reason, provider_called: false }),
    ],
  );
}

function preSendBlocker(context: SendContext): string | null {
  if (context.current_version === null || context.version === null || !context.proposal) {
    return "campaign_or_version_missing";
  }
  if (context.current_version !== context.version) return "version_superseded";
  if (!context.approval_id) return "approval_not_active";
  if (context.consent_state !== "true") return "consent_revoked";
  if (!context.contact_ref) return "no_contact_ref";
  return null;
}

/**
 * Attempt, job status and audit event land in one statement, so a crash between
 * them cannot leave a half-recorded result, and a settle costs one round trip.
 */
async function settle(
  db: Db,
  job: JobRow,
  input: {
    attemptNo: number;
    outcome: string;
    raw: string;
    providerMessageId: string | null;
    startedAt: string;
    status: string;
    audit: { action: string; oldState?: string; details: Record<string, unknown> };
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `WITH attempt AS (
       INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ), job AS (
       UPDATE delivery_job
          SET status = $9, attempt_count = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = $8
        WHERE id = $2
     ), audited AS (
       INSERT INTO audit_event
         (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details, created_at)
       VALUES ($10, $11, $12, $13, $2, 'worker', $14, $15, $16, $9, NULL, $17::jsonb, $8)
     )
     INSERT INTO integration_event (id, merchant_id, campaign_id, event, payload, status, created_at)
     SELECT $18, $11, $12, $14, jsonb_build_object('job_id', $2::text, 'new_state', $9::text) || $17::jsonb, $19, $8
      WHERE $14 = 'delivery.needs_review'`,
    [
      newId("att"),
      job.id,
      input.attemptNo,
      input.outcome,
      input.providerMessageId,
      input.raw,
      input.startedAt,
      now,
      input.status,
      newId("aud"),
      job.merchant_id,
      job.campaign_id,
      job.version_id,
      input.audit.action,
      `delivery_job:${job.id}`,
      input.audit.oldState ?? null,
      JSON.stringify(input.audit.details),
      newId("evt"),
      config.n8nWebhookUrl && config.n8nSecret ? "pending" : "skipped",
    ],
  );
}

async function processJob(db: Db, job: JobRow, provider: DeliveryProvider): Promise<string> {
  const context: SendContext = job;
  const blocker = preSendBlocker(context);
  if (blocker) {
    await cancelJob(db, job, blocker);
    return "CANCELLED";
  }

  const startedAt = new Date().toISOString();
  const attemptNo = job.attempt_count + 1;

  // Retry path: a previous attempt timed out, so prove nothing was delivered
  // before sending anything again.
  const recovering = job.status === "UNKNOWN" || job.status === "PROCESSING" || job.attempt_count > 0;
  if (recovering) {
    const status = await provider.getStatus(job.provider_key, { providerMessageId: job.last_provider_message_id });

    if (status.state === "delivered") {
      await settle(db, job, {
        attemptNo,
        outcome: `status_check_${status.state}`,
        raw: status.raw,
        providerMessageId: status.providerMessageId,
        startedAt,
        status: "DELIVERED",
        audit: {
          action: "delivery.status_confirmed_delivered",
          oldState: "UNKNOWN",
          details: { provider: provider.name, provider_message_id: status.providerMessageId },
        },
      });
      return "DELIVERED";
    }

    if (status.state === "unavailable") {
      await settle(db, job, {
        attemptNo,
        outcome: `status_check_${status.state}`,
        raw: status.raw,
        providerMessageId: null,
        startedAt,
        status: "NEEDS_REVIEW",
        audit: {
          action: "delivery.needs_review",
          oldState: "UNKNOWN",
          details: {
            provider: provider.name,
            reason: "provider status unavailable; automatic retry stopped to avoid duplicate outreach",
          },
        },
      });
      return "NEEDS_REVIEW";
    }

    // Status proves nothing was delivered: record the check, then re-send below.
    // A worker that died between this insert and the send leaves the row
    // behind; the reclaiming worker must not trip over it.
    await db.run(
      `INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
       ON CONFLICT (job_id, attempt_no) DO NOTHING`,
      [newId("att"), job.id, attemptNo, `status_check_${status.state}`, status.raw, startedAt, new Date().toISOString()],
    );
  }

  const proposal = context.proposal!;
  const result = await provider.send({
    providerKey: job.provider_key,
    recipientRef: context.contact_ref!,
    headline: proposal.copy.headline,
    body: proposal.copy_format === "separate_reward" ? `${proposal.copy.body} ${rewardPromise(proposal.offer)}` : proposal.copy.body,
    cta: proposal.copy.cta,
    scenarioSlot: job.scenario_slot,
  });

  const sendAttemptNo = recovering ? attemptNo + 1 : attemptNo;

  if (result.outcome === "delivered") {
    await settle(db, job, {
      attemptNo: sendAttemptNo,
      outcome: "delivered",
      raw: result.raw,
      providerMessageId: result.providerMessageId,
      startedAt,
      status: "DELIVERED",
      audit: {
        action: "delivery.delivered",
        details: { provider: provider.name, provider_message_id: result.providerMessageId, attempt: sendAttemptNo },
      },
    });
    return "DELIVERED";
  }

  if (result.outcome === "failed") {
    await settle(db, job, {
      attemptNo: sendAttemptNo,
      outcome: "failed",
      raw: result.raw,
      providerMessageId: null,
      startedAt,
      status: "FAILED",
      audit: {
        action: "delivery.failed",
        details: { provider: provider.name, reason: result.reason, attempt: sendAttemptNo },
      },
    });
    return "FAILED";
  }

  await settle(db, job, {
    attemptNo: sendAttemptNo,
    outcome: "timeout",
    raw: result.raw,
    // A provider that handed back an id before going quiet lets the retry
    // pass look the message up instead of sending it again.
    providerMessageId: result.providerMessageId ?? null,
    startedAt,
    status: "UNKNOWN",
    audit: {
      action: "delivery.unknown",
      details: {
        provider: provider.name,
        attempt: sendAttemptNo,
        note: "Provider timed out. Status will be checked before any retry.",
      },
    },
  });
  return "UNKNOWN";
}

export async function refreshCampaignDeliveryStatus(db: Db, campaignId: string): Promise<void> {
  const campaign = await db.one<{
    status: string;
    merchant_id: string;
    pending: number;
    delivered: number;
    failed: number;
    needs_review: number;
    total: number;
  }>(
    `SELECT c.status, c.merchant_id,
            COUNT(j.id) FILTER (WHERE j.status IN ('QUEUED', 'PROCESSING', 'UNKNOWN'))::int AS pending,
            COUNT(j.id) FILTER (WHERE j.status = 'DELIVERED')::int AS delivered,
            COUNT(j.id) FILTER (WHERE j.status = 'FAILED')::int AS failed,
            COUNT(j.id) FILTER (WHERE j.status = 'NEEDS_REVIEW')::int AS needs_review,
            COUNT(j.id)::int AS total
       FROM campaign c
       LEFT JOIN delivery_job j ON j.campaign_id = c.id AND j.status != 'CANCELLED'
      WHERE c.id = $1
      GROUP BY c.id`,
    [campaignId],
  );
  if (!campaign || ["OUTCOME_WINDOW", "REPORTED"].includes(campaign.status)) return;
  if (campaign.total === 0) return;

  let next = campaign.status;
  if (campaign.pending > 0) next = "SENDING";
  else if (campaign.needs_review > 0) next = "NEEDS_REVIEW";
  else if (campaign.delivered === 0) next = "FAILED";
  else if (campaign.failed > 0) next = "PARTIALLY_DELIVERED";
  else next = "SENDING";

  if (next !== campaign.status) {
    const now = new Date().toISOString();
    // Status change and its audit event in one statement.
    await db.run(
      `WITH changed AS (
         UPDATE campaign SET status = $1, updated_at = $2 WHERE id = $3
       ), audited AS (
         INSERT INTO audit_event
           (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details, created_at)
         VALUES ($4, $5, $3, NULL, NULL, 'worker', 'campaign.delivery_status_changed', $6, $7, $1, NULL, $8::jsonb, $2)
       )
       INSERT INTO integration_event (id, merchant_id, campaign_id, event, payload, status, created_at)
       VALUES ($9, $5, $3, 'campaign.delivery_status_changed', jsonb_build_object('old_state', $7::text, 'new_state', $1::text) || $8::jsonb, $10, $2)`,
      [
        next,
        now,
        campaignId,
        newId("aud"),
        campaign.merchant_id,
        `campaign:${campaignId}`,
        campaign.status,
        JSON.stringify({
          delivered: campaign.delivered,
          failed: campaign.failed,
          needs_review: campaign.needs_review,
          pending: campaign.pending,
        }),
        newId("evt"),
        config.n8nWebhookUrl && config.n8nSecret ? "pending" : "skipped",
      ],
    );
  }
}

export async function drainQueue(
  db: Db,
  options: { workerId?: string; provider?: DeliveryProvider; maxJobs?: number } = {},
): Promise<DrainSummary> {
  const workerId = options.workerId ?? `worker_${process.pid}`;
  const provider = options.provider ?? getDeliveryProvider();
  const maxJobs = options.maxJobs ?? 500;

  const summary: DrainSummary = {
    processed: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    needsReview: 0,
    cancelled: 0,
  };
  const touchedCampaigns = new Set<string>();

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimJob(db, workerId);
    if (!job) break;
    touchedCampaigns.add(job.campaign_id);

    const status = await processJob(db, job, provider);
    summary.processed += 1;
    if (status === "DELIVERED") summary.delivered += 1;
    else if (status === "FAILED") summary.failed += 1;
    else if (status === "UNKNOWN") summary.unknown += 1;
    else if (status === "NEEDS_REVIEW") summary.needsReview += 1;
    else if (status === "CANCELLED") summary.cancelled += 1;
  }

  for (const campaignId of touchedCampaigns) await refreshCampaignDeliveryStatus(db, campaignId);
  return summary;
}

async function runForever(): Promise<void> {
  const db = getDb();
  const provider = getDeliveryProvider();
  log("info", "worker.started", { pid: process.pid, provider: provider.name, live: provider.live });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      const summary = await drainQueue(db);
      if (summary.processed > 0) log("info", "worker.drained", { ...summary });
      await dispatchPendingEvents(db);
    } catch (error) {
      // A transient database error must not kill the worker; the lease makes
      // whatever was mid-flight claimable again once it expires.
      log("error", "worker.iteration_failed", { reason: "database_or_provider_unavailable" });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await closeDb();
  log("info", "worker.stopped", {});
}

const isDirectRun = process.argv[1]?.endsWith("runner.ts") || process.argv[1]?.endsWith("runner.js");
if (isDirectRun) {
  runForever().catch((error) => {
    log("error", "worker.crashed", { reason: "database_or_provider_unavailable" });
    process.exitCode = 1;
  });
}
