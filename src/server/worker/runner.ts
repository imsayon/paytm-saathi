import { recordAudit } from "../audit/events";
import { closeDb, getDb, newId, type Db } from "../db/client";
import { log } from "../observability/log";
import { mockProvider } from "../providers/mock";
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
};

export type DrainSummary = {
  processed: number;
  delivered: number;
  failed: number;
  unknown: number;
  needsReview: number;
  cancelled: number;
};

/**
 * Atomic claim: the row lock with SKIP LOCKED means a second worker cannot take
 * a job whose lease is still live, and an expired lease becomes claimable again
 * after a crash. One statement, one round trip, committed before any provider call.
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
      RETURNING j.id, j.merchant_id, j.campaign_id, j.version_id, j.recipient_id, j.customer_id, candidate.status, j.provider_key, j.attempt_count, j.scenario_slot`,
    [workerId, leaseExpiry, nowIso, MAX_ATTEMPTS, nowIso],
  );
  return claimed ?? null;
}

async function cancelJob(db: Db, job: JobRow, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE delivery_job SET status = 'CANCELLED', cancel_reason = $1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $2 WHERE id = $3`,
      [reason, new Date().toISOString(), job.id],
    );
    await recordAudit(tx, {
      merchantId: job.merchant_id,
      campaignId: job.campaign_id,
      versionId: job.version_id,
      jobId: job.id,
      actor: "worker",
      action: "delivery.cancelled",
      entity: `delivery_job:${job.id}`,
      newState: "CANCELLED",
      details: { reason, provider_called: false },
    });
  });
}

type SendContext = {
  current_version: number | null;
  version: number | null;
  approval_id: string | null;
  consent_state: string | null;
  contact_ref: string | null;
  proposal: Proposal | null;
};

/**
 * One read for everything the pre-send check and the send itself need. Consent
 * and version are re-checked here, immediately before any provider call.
 */
async function loadSendContext(db: Db, job: JobRow): Promise<SendContext> {
  const row = await db.one<SendContext>(
    `SELECT c.current_version,
            v.version,
            v.proposal,
            cu.contact_ref,
            (SELECT a.id FROM campaign_approval a WHERE a.version_id = j.version_id AND a.status = 'active' LIMIT 1) AS approval_id,
            (SELECT cs.state FROM consent cs
              WHERE cs.merchant_id = j.merchant_id AND cs.customer_id = j.customer_id
              ORDER BY cs.observed_at DESC, cs.seq DESC LIMIT 1) AS consent_state
       FROM delivery_job j
       LEFT JOIN campaign c ON c.id = j.campaign_id
       LEFT JOIN campaign_version v ON v.id = j.version_id
       LEFT JOIN customer cu ON cu.id = j.customer_id
      WHERE j.id = $1`,
    [job.id],
  );
  return (
    row ?? { current_version: null, version: null, approval_id: null, consent_state: null, contact_ref: null, proposal: null }
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

/** Attempt, job status and audit event land together, so a crash between them cannot leave a half-recorded result. */
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
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId("att"), job.id, input.attemptNo, input.outcome, input.providerMessageId, input.raw, input.startedAt, new Date().toISOString()],
    );
    await tx.run(
      `UPDATE delivery_job SET status = $1, attempt_count = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = $3 WHERE id = $4`,
      [input.status, input.attemptNo, new Date().toISOString(), job.id],
    );
    await recordAudit(tx, {
      merchantId: job.merchant_id,
      campaignId: job.campaign_id,
      versionId: job.version_id,
      jobId: job.id,
      actor: "worker",
      action: input.audit.action,
      entity: `delivery_job:${job.id}`,
      oldState: input.audit.oldState ?? null,
      newState: input.status,
      details: input.audit.details,
    });
  });
}

async function processJob(db: Db, job: JobRow, provider: DeliveryProvider): Promise<string> {
  const context = await loadSendContext(db, job);
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
    const status = await provider.getStatus(job.provider_key);

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
    await db.run(
      `INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
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
    providerMessageId: null,
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
  const counts = await db.all<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM delivery_job WHERE campaign_id = $1 AND status != 'CANCELLED' GROUP BY status`,
    [campaignId],
  );

  const by = (status: string) => counts.find((row) => row.status === status)?.n ?? 0;
  const pending = by("QUEUED") + by("PROCESSING") + by("UNKNOWN");
  const delivered = by("DELIVERED");
  const failed = by("FAILED");
  const needsReview = by("NEEDS_REVIEW");
  const total = counts.reduce((sum, row) => sum + row.n, 0);

  const campaign = await db.one<{ status: string; merchant_id: string }>(
    `SELECT status, merchant_id FROM campaign WHERE id = $1`,
    [campaignId],
  );
  if (!campaign || ["OUTCOME_WINDOW", "REPORTED"].includes(campaign.status)) return;
  if (total === 0) return;

  let next = campaign.status;
  if (pending > 0) next = "SENDING";
  else if (needsReview > 0) next = "NEEDS_REVIEW";
  else if (delivered === 0) next = "FAILED";
  else if (failed > 0) next = "PARTIALLY_DELIVERED";
  else next = "SENDING";

  if (next !== campaign.status) {
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE campaign SET status = $1, updated_at = $2 WHERE id = $3`, [
        next,
        new Date().toISOString(),
        campaignId,
      ]);
      await recordAudit(tx, {
        merchantId: campaign.merchant_id,
        campaignId,
        actor: "worker",
        action: "campaign.delivery_status_changed",
        entity: `campaign:${campaignId}`,
        oldState: campaign.status,
        newState: next,
        details: { delivered, failed, needs_review: needsReview, pending },
      });
    });
  }
}

export async function drainQueue(
  db: Db,
  options: { workerId?: string; provider?: DeliveryProvider; maxJobs?: number } = {},
): Promise<DrainSummary> {
  const workerId = options.workerId ?? `worker_${process.pid}`;
  const provider = options.provider ?? mockProvider;
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
  log("info", "worker.started", { pid: process.pid, provider: mockProvider.name });
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
