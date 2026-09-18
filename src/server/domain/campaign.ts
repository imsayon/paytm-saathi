import crypto from "node:crypto";
import { recordAudit } from "../audit/events";
import type { MerchantContext } from "../auth/context";
import { assertOwnedByMerchant } from "../auth/context";
import { inWriteTransaction, newId, type Db } from "../db/client";
import { AppError } from "../errors";
import { validateProposal, type Proposal, type RuleResult } from "./rules";
import { computeSignal, stableHash, type SignalSummary } from "./signal";

export type CampaignStatus =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "QUEUED"
  | "SENDING"
  | "PARTIALLY_DELIVERED"
  | "NEEDS_REVIEW"
  | "OUTCOME_WINDOW"
  | "REPORTED"
  | "EXPIRED"
  | "FAILED";

export type CampaignRow = {
  id: string;
  merchant_id: string;
  intent: string;
  status: CampaignStatus;
  current_version: number;
  as_of: string;
  window_start: string | null;
  window_end: string | null;
  created_at: string;
  updated_at: string;
};

export type VersionRow = {
  id: string;
  campaign_id: string;
  merchant_id: string;
  version: number;
  proposal_json: string;
  rule_result_json: string;
  cohort_hash: string;
  cap_minor: number;
  policy_version: string;
  ai_source: "model" | "template_fallback";
  created_by: string;
  created_at: string;
};

export type RecipientRow = {
  id: string;
  version_id: string;
  customer_id: string;
  assignment_group: "campaign" | "holdout";
  eligibility_reason: string;
  reward_amount_minor: number;
};

export function providerKeyFor(versionId: string, customerId: string): string {
  return `mock_${crypto.createHash("sha256").update(`${versionId}|${customerId}`).digest("hex").slice(0, 32)}`;
}

export function loadCampaign(db: Db, ctx: MerchantContext, campaignId: string): CampaignRow {
  const row = db.prepare(`SELECT * FROM campaign WHERE id = ?`).get(campaignId) as CampaignRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", "Campaign not found.");
  assertOwnedByMerchant(row.merchant_id, ctx);
  return row;
}

export function loadVersion(db: Db, campaignId: string, version: number): VersionRow {
  const row = db
    .prepare(`SELECT * FROM campaign_version WHERE campaign_id = ? AND version = ?`)
    .get(campaignId, version) as VersionRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `Version ${version} not found for this campaign.`);
  return row;
}

export function listRecipients(db: Db, versionId: string): RecipientRow[] {
  return db
    .prepare(`SELECT * FROM campaign_recipient WHERE version_id = ? ORDER BY assignment_group, rowid`)
    .all(versionId) as RecipientRow[];
}

/**
 * Assignment is computed once per version and then stored. Nothing downstream
 * recomputes it, so a later import or re-sort cannot move a customer between
 * the campaign and holdout groups after approval.
 */
function assignGroups(campaignId: string, signal: SignalSummary): { customerId: string; group: "campaign" | "holdout" }[] {
  const ordered = [...signal.eligible].sort((a, b) =>
    stableHash(campaignId, a.customerId).localeCompare(stableHash(campaignId, b.customerId)),
  );
  const campaignSize = Math.floor(ordered.length / 2);
  return ordered.map((customer, index) => ({
    customerId: customer.customerId,
    group: index < campaignSize ? "campaign" : "holdout",
  }));
}

function writeVersion(
  db: Db,
  input: {
    ctx: MerchantContext;
    campaignId: string;
    version: number;
    proposal: Proposal;
    ruleResult: RuleResult;
    signal: SignalSummary;
    capMinor: number;
    aiSource: "model" | "template_fallback";
  },
): VersionRow {
  const versionId = newId("ver");
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO campaign_version
       (id, campaign_id, merchant_id, version, proposal_json, rule_result_json, cohort_hash, cap_minor, policy_version, ai_source, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    versionId,
    input.campaignId,
    input.ctx.merchantId,
    input.version,
    JSON.stringify(input.proposal),
    JSON.stringify(input.ruleResult),
    input.signal.cohortHash,
    input.capMinor,
    input.signal.policy.version,
    input.aiSource,
    input.ctx.actor,
    now,
  );

  const insertRecipient = db.prepare(
    `INSERT INTO campaign_recipient
       (id, version_id, merchant_id, customer_id, assignment_group, eligibility_reason, reward_amount_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const assignment of assignGroups(input.campaignId, input.signal)) {
    insertRecipient.run(
      newId("rcp"),
      versionId,
      input.ctx.merchantId,
      assignment.customerId,
      assignment.group,
      `regular_absent_${input.signal.policy.inactivityDays}d_consented`,
      assignment.group === "campaign" ? input.proposal.offer.amount_minor : 0,
    );
  }

  const insertExclusion = db.prepare(
    `INSERT INTO campaign_exclusion (id, version_id, merchant_id, customer_id, reason) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const customer of input.signal.absent) {
    if (customer.exclusionReason) {
      insertExclusion.run(newId("exc"), versionId, input.ctx.merchantId, customer.customerId, customer.exclusionReason);
    }
  }

  return loadVersion(db, input.campaignId, input.version);
}

export type PreviewInput = {
  intent: string;
  budgetCapMinor: number;
  asOf: string;
  proposal: Proposal;
  aiSource: "model" | "template_fallback";
  fallbackReason: string | null;
  requestId?: string;
};

export function createCampaignPreview(db: Db, ctx: MerchantContext, input: PreviewInput) {
  const signal = computeSignal(db, ctx.merchantId, input.asOf);
  const ruleResult = validateProposal({
    proposal: input.proposal,
    signal,
    budgetCapMinor: input.budgetCapMinor,
  });

  return inWriteTransaction(db, () => {
    const campaignId = newId("cmp");
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO campaign (id, merchant_id, intent, status, current_version, as_of, created_at, updated_at)
       VALUES (?, ?, ?, 'REVIEW', 1, ?, ?, ?)`,
    ).run(campaignId, ctx.merchantId, input.intent, input.asOf, now, now);

    const version = writeVersion(db, {
      ctx,
      campaignId,
      version: 1,
      proposal: input.proposal,
      ruleResult,
      signal,
      capMinor: input.budgetCapMinor,
      aiSource: input.aiSource,
    });

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId,
      versionId: version.id,
      actor: ctx.actor,
      action: "campaign.created",
      entity: `campaign:${campaignId}`,
      newState: "REVIEW",
      requestId: input.requestId ?? null,
      details: {
        version: 1,
        ai_source: input.aiSource,
        fallback_reason: input.fallbackReason,
        audience_count: ruleResult.audience_count,
        estimated_cost_minor: ruleResult.estimated_cost_minor,
        budget_cap_minor: input.budgetCapMinor,
        rules_passed: ruleResult.eligible,
        rule_errors: ruleResult.errors.map((error) => error.code),
      },
    });

    return { campaignId, version, ruleResult, signal };
  });
}

export type ReviseInput = {
  campaignId: string;
  proposal: Proposal;
  budgetCapMinor: number;
  requestId?: string;
};

export function reviseCampaign(db: Db, ctx: MerchantContext, input: ReviseInput) {
  const campaign = loadCampaign(db, ctx, input.campaignId);
  if (["REPORTED", "EXPIRED", "FAILED"].includes(campaign.status)) {
    throw new AppError("RULE_VIOLATION", `A ${campaign.status} campaign cannot be revised.`);
  }

  const signal = computeSignal(db, ctx.merchantId, campaign.as_of);
  const ruleResult = validateProposal({
    proposal: input.proposal,
    signal,
    budgetCapMinor: input.budgetCapMinor,
  });

  return inWriteTransaction(db, () => {
    const nextVersion = campaign.current_version + 1;
    const version = writeVersion(db, {
      ctx,
      campaignId: campaign.id,
      version: nextVersion,
      proposal: input.proposal,
      ruleResult,
      signal,
      capMinor: input.budgetCapMinor,
      aiSource: "template_fallback",
    });

    // A changed plan cannot inherit an old authorization.
    const expired = db
      .prepare(`UPDATE campaign_approval SET status = 'expired' WHERE campaign_id = ? AND status = 'active'`)
      .run(campaign.id);

    const cancelled = db
      .prepare(
        `UPDATE delivery_job
            SET status = 'CANCELLED', cancel_reason = 'version_superseded', updated_at = ?
          WHERE campaign_id = ? AND status = 'QUEUED'`,
      )
      .run(new Date().toISOString(), campaign.id);

    db.prepare(`UPDATE campaign SET current_version = ?, status = 'REVIEW', updated_at = ? WHERE id = ?`).run(
      nextVersion,
      new Date().toISOString(),
      campaign.id,
    );

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      versionId: version.id,
      actor: ctx.actor,
      action: "campaign.version_changed",
      entity: `campaign:${campaign.id}`,
      oldState: campaign.status,
      newState: "REVIEW",
      requestId: input.requestId ?? null,
      details: {
        version: nextVersion,
        previous_version: campaign.current_version,
        approvals_expired: expired.changes,
        queued_jobs_cancelled: cancelled.changes,
        reward_minor: input.proposal.offer.amount_minor,
        estimated_cost_minor: ruleResult.estimated_cost_minor,
        rules_passed: ruleResult.eligible,
      },
    });

    return { campaign, version, ruleResult, signal };
  });
}

export type ApproveInput = {
  campaignId: string;
  version: number;
  idempotencyKey: string;
  requestId?: string;
};

export type ApproveResult = {
  approvalId: string;
  versionId: string;
  version: number;
  status: CampaignStatus;
  jobsQueued: number;
  replayed: boolean;
};

export function approveCampaign(db: Db, ctx: MerchantContext, input: ApproveInput): ApproveResult {
  if (!input.idempotencyKey.trim()) {
    throw new AppError("BAD_REQUEST", "An Idempotency-Key header is required to approve a campaign.");
  }

  return inWriteTransaction(db, () => {
    const campaign = loadCampaign(db, ctx, input.campaignId);
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${campaign.id}|${input.version}`)
      .digest("hex");

    const priorByKey = db
      .prepare(`SELECT * FROM campaign_approval WHERE merchant_id = ? AND idempotency_key = ?`)
      .get(ctx.merchantId, input.idempotencyKey) as
      | {
          id: string;
          campaign_id: string;
          version_id: string;
          version: number;
          request_fingerprint: string;
        }
      | undefined;

    if (priorByKey) {
      if (priorByKey.request_fingerprint !== fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used for a different approval request.",
        );
      }
      const jobsQueued = (
        db.prepare(`SELECT COUNT(*) AS n FROM delivery_job WHERE version_id = ?`).get(priorByKey.version_id) as {
          n: number;
        }
      ).n;
      const current = db.prepare(`SELECT status FROM campaign WHERE id = ?`).get(campaign.id) as {
        status: CampaignStatus;
      };
      return {
        approvalId: priorByKey.id,
        versionId: priorByKey.version_id,
        version: priorByKey.version,
        status: current.status,
        jobsQueued,
        replayed: true,
      };
    }

    if (input.version !== campaign.current_version) {
      throw new AppError(
        "STALE_VERSION",
        `Version ${input.version} is no longer current. The campaign is now at version ${campaign.current_version}.`,
        { submitted_version: input.version, current_version: campaign.current_version },
      );
    }

    if (campaign.status !== "REVIEW") {
      throw new AppError(
        "DUPLICATE_APPROVAL",
        `Campaign is ${campaign.status} and is not awaiting approval.`,
        { status: campaign.status },
      );
    }

    const version = loadVersion(db, campaign.id, input.version);
    const alreadyApproved = db
      .prepare(`SELECT id FROM campaign_approval WHERE version_id = ? AND status = 'active'`)
      .get(version.id);
    if (alreadyApproved) {
      throw new AppError("DUPLICATE_APPROVAL", "This version was already approved with a different key.");
    }

    // Re-run the same rules against fresh data: consent or eligibility may have
    // changed between preview and approval.
    const signal = computeSignal(db, ctx.merchantId, campaign.as_of);
    const proposal = JSON.parse(version.proposal_json) as Proposal;
    const ruleResult = validateProposal({ proposal, signal, budgetCapMinor: version.cap_minor });

    if (!ruleResult.eligible) {
      throw new AppError("RULE_VIOLATION", "Approval blocked: the campaign no longer passes validation.", {
        errors: ruleResult.errors,
      });
    }

    if (signal.cohortHash !== version.cohort_hash) {
      throw new AppError(
        "RULE_VIOLATION",
        "The eligible cohort changed after this version was created. Re-run the proposal before approving.",
        { stored_cohort_hash: version.cohort_hash, current_cohort_hash: signal.cohortHash },
      );
    }

    const recipients = listRecipients(db, version.id);
    const campaignGroup = recipients.filter((recipient) => recipient.assignment_group === "campaign");
    const stillEligible = new Set(signal.eligible.map((customer) => customer.customerId));
    const lostConsent = campaignGroup.filter((recipient) => !stillEligible.has(recipient.customer_id));
    if (lostConsent.length > 0) {
      throw new AppError(
        "RULE_VIOLATION",
        `${lostConsent.length} recipient(s) are no longer contactable. Re-run the proposal to rebuild the audience.`,
        { affected_recipients: lostConsent.length },
      );
    }

    const now = new Date().toISOString();
    const approvalId = newId("apr");
    db.prepare(
      `INSERT INTO campaign_approval
         (id, campaign_id, merchant_id, version_id, version, approver, idempotency_key, request_fingerprint, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      approvalId,
      campaign.id,
      ctx.merchantId,
      version.id,
      version.version,
      ctx.actor,
      input.idempotencyKey,
      fingerprint,
      now,
    );

    // Only the campaign group is contacted. The holdout is the control and must
    // never receive a message, so it never gets a delivery job.
    const insertJob = db.prepare(
      `INSERT INTO delivery_job
         (id, merchant_id, campaign_id, version_id, recipient_id, customer_id, status, provider_key, scenario_slot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
    );
    const ordered = [...campaignGroup].sort((a, b) =>
      providerKeyFor(version.id, a.customer_id).localeCompare(providerKeyFor(version.id, b.customer_id)),
    );
    ordered.forEach((recipient, slot) => {
      insertJob.run(
        newId("job"),
        ctx.merchantId,
        campaign.id,
        version.id,
        recipient.id,
        recipient.customer_id,
        providerKeyFor(version.id, recipient.customer_id),
        slot,
        now,
        now,
      );
    });

    db.prepare(`UPDATE campaign SET status = 'QUEUED', updated_at = ? WHERE id = ?`).run(now, campaign.id);

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      versionId: version.id,
      actor: ctx.actor,
      action: "campaign.approved",
      entity: `campaign:${campaign.id}`,
      oldState: "REVIEW",
      newState: "APPROVED",
      requestId: input.requestId ?? null,
      details: {
        version: version.version,
        approval_id: approvalId,
        idempotency_key: input.idempotencyKey,
        audience_count: ruleResult.audience_count,
        estimated_cost_minor: ruleResult.estimated_cost_minor,
      },
    });

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      versionId: version.id,
      actor: "system",
      action: "jobs.queued",
      entity: `campaign_version:${version.id}`,
      oldState: "APPROVED",
      newState: "QUEUED",
      requestId: input.requestId ?? null,
      details: {
        jobs_queued: ordered.length,
        holdout_size: recipients.length - campaignGroup.length,
        provider: "mock",
        note: "No provider call happens in this transaction.",
      },
    });

    return {
      approvalId,
      versionId: version.id,
      version: version.version,
      status: "QUEUED" as CampaignStatus,
      jobsQueued: ordered.length,
      replayed: false,
    };
  });
}
