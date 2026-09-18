import { recordAudit } from "../audit/events";
import { getDb, newId, type Db } from "../db/client";
import { log } from "../observability/log";
import { mockProvider } from "../providers/mock";
import type { DeliveryProvider } from "../providers/types";
import type { Proposal } from "../domain/rules";

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
 * Atomic claim: the conditional UPDATE means a second worker cannot take a job
 * whose lease is still live, and an expired lease becomes claimable again after
 * a crash.
 */
function claimJob(db: Db, workerId: string): JobRow | null {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseExpiry = new Date(now + LEASE_MS).toISOString();

  const claimed = db
    .prepare(
      `UPDATE delivery_job
          SET status = 'PROCESSING', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM delivery_job
           WHERE status = 'QUEUED'
              OR (status = 'UNKNOWN' AND attempt_count < ?)
              OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
           ORDER BY rowid
           LIMIT 1
        )
          AND (
            status = 'QUEUED'
            OR (status = 'UNKNOWN' AND attempt_count < ?)
            OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          )
        RETURNING id`,
    )
    .get(workerId, leaseExpiry, nowIso, MAX_ATTEMPTS, nowIso, MAX_ATTEMPTS, nowIso) as { id: string } | undefined;

  if (!claimed) return null;
  return db.prepare(`SELECT * FROM delivery_job WHERE id = ?`).get(claimed.id) as JobRow;
}

function cancelJob(db: Db, job: JobRow, reason: string): void {
  db.prepare(
    `UPDATE delivery_job SET status = 'CANCELLED', cancel_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(reason, new Date().toISOString(), job.id);

  recordAudit(db, {
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
}

/** Consent and version are re-checked here, immediately before any provider call. */
function preSendBlocker(db: Db, job: JobRow): string | null {
  const campaign = db
    .prepare(`SELECT current_version FROM campaign WHERE id = ?`)
    .get(job.campaign_id) as { current_version: number } | undefined;
  const version = db
    .prepare(`SELECT version FROM campaign_version WHERE id = ?`)
    .get(job.version_id) as { version: number } | undefined;

  if (!campaign || !version) return "campaign_or_version_missing";
  if (campaign.current_version !== version.version) return "version_superseded";

  const approval = db
    .prepare(`SELECT id FROM campaign_approval WHERE version_id = ? AND status = 'active'`)
    .get(job.version_id);
  if (!approval) return "approval_not_active";

  const consent = db
    .prepare(
      `SELECT state FROM consent WHERE merchant_id = ? AND customer_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
    )
    .get(job.merchant_id, job.customer_id) as { state: string } | undefined;
  if (!consent || consent.state !== "true") return "consent_revoked";

  const customer = db
    .prepare(`SELECT contact_ref FROM customer WHERE id = ?`)
    .get(job.customer_id) as { contact_ref: string | null } | undefined;
  if (!customer?.contact_ref) return "no_contact_ref";

  return null;
}

function recordAttempt(
  db: Db,
  job: JobRow,
  attemptNo: number,
  outcome: string,
  raw: string,
  providerMessageId: string | null,
  startedAt: string,
): void {
  db.prepare(
    `INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("att"), job.id, attemptNo, outcome, providerMessageId, raw, startedAt, new Date().toISOString());
}

function finishJob(db: Db, job: JobRow, status: string, attemptCount: number): void {
  db.prepare(
    `UPDATE delivery_job SET status = ?, attempt_count = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(status, attemptCount, new Date().toISOString(), job.id);
}

async function processJob(db: Db, job: JobRow, provider: DeliveryProvider): Promise<string> {
  const blocker = preSendBlocker(db, job);
  if (blocker) {
    cancelJob(db, job, blocker);
    return "CANCELLED";
  }

  const startedAt = new Date().toISOString();
  const attemptNo = job.attempt_count + 1;

  // Retry path: a previous attempt timed out, so prove nothing was delivered
  // before sending anything again.
  if (job.status === "UNKNOWN" || job.attempt_count > 0) {
    const status = await provider.getStatus(job.provider_key);
    recordAttempt(db, job, attemptNo, `status_check_${status.state}`, status.raw, null, startedAt);

    if (status.state === "delivered") {
      finishJob(db, job, "DELIVERED", attemptNo);
      recordAudit(db, {
        merchantId: job.merchant_id,
        campaignId: job.campaign_id,
        versionId: job.version_id,
        jobId: job.id,
        actor: "worker",
        action: "delivery.status_confirmed_delivered",
        entity: `delivery_job:${job.id}`,
        oldState: "UNKNOWN",
        newState: "DELIVERED",
        details: { provider: provider.name, provider_message_id: status.providerMessageId },
      });
      return "DELIVERED";
    }

    if (status.state === "unavailable") {
      finishJob(db, job, "NEEDS_REVIEW", attemptNo);
      recordAudit(db, {
        merchantId: job.merchant_id,
        campaignId: job.campaign_id,
        versionId: job.version_id,
        jobId: job.id,
        actor: "worker",
        action: "delivery.needs_review",
        entity: `delivery_job:${job.id}`,
        oldState: "UNKNOWN",
        newState: "NEEDS_REVIEW",
        details: {
          provider: provider.name,
          reason: "provider status unavailable; automatic retry stopped to avoid duplicate outreach",
        },
      });
      return "NEEDS_REVIEW";
    }
  }

  const proposal = JSON.parse(
    (db.prepare(`SELECT proposal_json FROM campaign_version WHERE id = ?`).get(job.version_id) as {
      proposal_json: string;
    }).proposal_json,
  ) as Proposal;

  const customer = db.prepare(`SELECT contact_ref FROM customer WHERE id = ?`).get(job.customer_id) as {
    contact_ref: string;
  };

  const result = await provider.send({
    providerKey: job.provider_key,
    recipientRef: customer.contact_ref,
    headline: proposal.copy.headline,
    body: proposal.copy.body,
    cta: proposal.copy.cta,
    scenarioSlot: job.scenario_slot,
  });

  const sendAttemptNo = job.attempt_count > 0 ? attemptNo + 1 : attemptNo;

  if (result.outcome === "delivered") {
    recordAttempt(db, job, sendAttemptNo, "delivered", result.raw, result.providerMessageId, startedAt);
    finishJob(db, job, "DELIVERED", sendAttemptNo);
    recordAudit(db, {
      merchantId: job.merchant_id,
      campaignId: job.campaign_id,
      versionId: job.version_id,
      jobId: job.id,
      actor: "worker",
      action: "delivery.delivered",
      entity: `delivery_job:${job.id}`,
      newState: "DELIVERED",
      details: { provider: provider.name, provider_message_id: result.providerMessageId, attempt: sendAttemptNo },
    });
    return "DELIVERED";
  }

  if (result.outcome === "failed") {
    recordAttempt(db, job, sendAttemptNo, "failed", result.raw, null, startedAt);
    finishJob(db, job, "FAILED", sendAttemptNo);
    recordAudit(db, {
      merchantId: job.merchant_id,
      campaignId: job.campaign_id,
      versionId: job.version_id,
      jobId: job.id,
      actor: "worker",
      action: "delivery.failed",
      entity: `delivery_job:${job.id}`,
      newState: "FAILED",
      details: { provider: provider.name, reason: result.reason, attempt: sendAttemptNo },
    });
    return "FAILED";
  }

  recordAttempt(db, job, sendAttemptNo, "timeout", result.raw, null, startedAt);
  finishJob(db, job, "UNKNOWN", sendAttemptNo);
  recordAudit(db, {
    merchantId: job.merchant_id,
    campaignId: job.campaign_id,
    versionId: job.version_id,
    jobId: job.id,
    actor: "worker",
    action: "delivery.unknown",
    entity: `delivery_job:${job.id}`,
    newState: "UNKNOWN",
    details: {
      provider: provider.name,
      attempt: sendAttemptNo,
      note: "Provider timed out. Status will be checked before any retry.",
    },
  });
  return "UNKNOWN";
}

export function refreshCampaignDeliveryStatus(db: Db, campaignId: string): void {
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM delivery_job WHERE campaign_id = ? AND status != 'CANCELLED' GROUP BY status`,
    )
    .all(campaignId) as { status: string; n: number }[];

  const by = (status: string) => counts.find((row) => row.status === status)?.n ?? 0;
  const pending = by("QUEUED") + by("PROCESSING") + by("UNKNOWN");
  const delivered = by("DELIVERED");
  const failed = by("FAILED");
  const needsReview = by("NEEDS_REVIEW");
  const total = counts.reduce((sum, row) => sum + row.n, 0);

  const campaign = db.prepare(`SELECT status FROM campaign WHERE id = ?`).get(campaignId) as
    | { status: string }
    | undefined;
  if (!campaign || ["OUTCOME_WINDOW", "REPORTED"].includes(campaign.status)) return;
  if (total === 0) return;

  let next = campaign.status;
  if (pending > 0) next = "SENDING";
  else if (needsReview > 0) next = "NEEDS_REVIEW";
  else if (delivered === 0) next = "FAILED";
  else if (failed > 0) next = "PARTIALLY_DELIVERED";
  else next = "SENDING";

  if (next !== campaign.status) {
    db.prepare(`UPDATE campaign SET status = ?, updated_at = ? WHERE id = ?`).run(
      next,
      new Date().toISOString(),
      campaignId,
    );
    recordAudit(db, {
      merchantId: (db.prepare(`SELECT merchant_id FROM campaign WHERE id = ?`).get(campaignId) as {
        merchant_id: string;
      }).merchant_id,
      campaignId,
      actor: "worker",
      action: "campaign.delivery_status_changed",
      entity: `campaign:${campaignId}`,
      oldState: campaign.status,
      newState: next,
      details: { delivered, failed, needs_review: needsReview, pending },
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
    const job = claimJob(db, workerId);
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

  for (const campaignId of touchedCampaigns) refreshCampaignDeliveryStatus(db, campaignId);
  return summary;
}

async function runForever(): Promise<void> {
  const db = getDb();
  log("info", "worker.started", { pid: process.pid, provider: mockProvider.name });
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  while (running) {
    const summary = await drainQueue(db);
    if (summary.processed > 0) log("info", "worker.drained", { ...summary });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log("info", "worker.stopped", {});
}

const isDirectRun = process.argv[1]?.endsWith("runner.ts") || process.argv[1]?.endsWith("runner.js");
if (isDirectRun) {
  runForever().catch((error) => {
    log("error", "worker.crashed", { reason: error instanceof Error ? error.message : "unknown" });
    process.exitCode = 1;
  });
}
