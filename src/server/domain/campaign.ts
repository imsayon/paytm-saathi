import crypto from "node:crypto";
import { recordAudit } from "../audit/events";
import type { MerchantContext } from "../auth/context";
import { assertOwnedByMerchant } from "../auth/context";
import { newId, type Db } from "../db/client";
import { AppError } from "../errors";
import { rememberFact } from "../memory/store";
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
  proposal: Proposal;
  rule_result: RuleResult;
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

/**
 * `forUpdate` takes a row lock inside the caller's transaction, so two
 * concurrent approvals of the same campaign serialize instead of both reading
 * "not yet approved".
 */
export async function loadCampaign(
  db: Db,
  ctx: MerchantContext,
  campaignId: string,
  options: { forUpdate?: boolean } = {},
): Promise<CampaignRow> {
  const row = await db.one<CampaignRow>(
    `SELECT * FROM campaign WHERE id = $1${options.forUpdate ? " FOR UPDATE" : ""}`,
    [campaignId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Campaign not found.");
  assertOwnedByMerchant(row.merchant_id, ctx);
  return row;
}

export async function loadVersion(db: Db, campaignId: string, version: number): Promise<VersionRow> {
  const row = await db.one<VersionRow>(`SELECT * FROM campaign_version WHERE campaign_id = $1 AND version = $2`, [
    campaignId,
    version,
  ]);
  if (!row) throw new AppError("NOT_FOUND", `Version ${version} not found for this campaign.`);
  return row;
}

export function listRecipients(db: Db, versionId: string): Promise<RecipientRow[]> {
  return db.all<RecipientRow>(
    `SELECT id, version_id, customer_id, assignment_group, eligibility_reason, reward_amount_minor
       FROM campaign_recipient WHERE version_id = $1 ORDER BY assignment_group, seq`,
    [versionId],
  );
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

async function writeVersion(
  tx: Db,
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
): Promise<VersionRow> {
  const versionId = newId("ver");
  const now = new Date().toISOString();

  await tx.run(
    `INSERT INTO campaign_version
       (id, campaign_id, merchant_id, version, proposal, rule_result, cohort_hash, cap_minor, policy_version, ai_source, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
    [
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
    ],
  );

  await tx.insertMany(
    "campaign_recipient",
    ["id", "version_id", "merchant_id", "customer_id", "assignment_group", "eligibility_reason", "reward_amount_minor"],
    assignGroups(input.campaignId, input.signal).map((assignment) => [
      newId("rcp"),
      versionId,
      input.ctx.merchantId,
      assignment.customerId,
      assignment.group,
      `regular_absent_${input.signal.policy.inactivityDays}d_consented`,
      assignment.group === "campaign" ? input.proposal.offer.amount_minor : 0,
    ]),
  );

  await tx.insertMany(
    "campaign_exclusion",
    ["id", "version_id", "merchant_id", "customer_id", "reason"],
    input.signal.absent
      .filter((customer) => customer.exclusionReason)
      .map((customer) => [newId("exc"), versionId, input.ctx.merchantId, customer.customerId, customer.exclusionReason]),
  );

  return loadVersion(tx, input.campaignId, input.version);
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

export async function createCampaignPreview(db: Db, ctx: MerchantContext, input: PreviewInput) {
  const signal = await computeSignal(db, ctx.merchantId, input.asOf);
  const ruleResult = validateProposal({
    proposal: input.proposal,
    signal,
    budgetCapMinor: input.budgetCapMinor,
  });

  return db.transaction(async (tx) => {
    const campaignId = newId("cmp");
    const now = new Date().toISOString();

    await tx.run(
      `INSERT INTO campaign (id, merchant_id, intent, status, current_version, as_of, created_at, updated_at)
       VALUES ($1, $2, $3, 'REVIEW', 1, $4, $5, $6)`,
      [campaignId, ctx.merchantId, input.intent, input.asOf, now, now],
    );

    const version = await writeVersion(tx, {
      ctx,
      campaignId,
      version: 1,
      proposal: input.proposal,
      ruleResult,
      signal,
      capMinor: input.budgetCapMinor,
      aiSource: input.aiSource,
    });

    await recordAudit(tx, {
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

    if (!ruleResult.eligible) {
      await rememberFact(tx, {
        merchantId: ctx.merchantId,
        campaignId,
        kind: "draft_blocked",
        fact: `A draft at ₹${(input.proposal.offer.amount_minor / 100).toFixed(2)} for ${ruleResult.audience_count} eligible customers was blocked (${ruleResult.errors.map((e) => e.code).join(", ")}); the cap was ₹${(input.budgetCapMinor / 100).toFixed(2)}.`,
        details: { reward_minor: input.proposal.offer.amount_minor, cap_minor: input.budgetCapMinor, errors: ruleResult.errors.map((e) => e.code) },
      });
    }

    return { campaignId, version, ruleResult, signal };
  });
}

export type ReviseInput = {
  campaignId: string;
  proposal: Proposal;
  budgetCapMinor: number;
  requestId?: string;
};

export async function reviseCampaign(db: Db, ctx: MerchantContext, input: ReviseInput) {
  const existing = await loadCampaign(db, ctx, input.campaignId);
  if (["REPORTED", "EXPIRED", "FAILED"].includes(existing.status)) {
    throw new AppError("RULE_VIOLATION", `A ${existing.status} campaign cannot be revised.`);
  }

  const signal = await computeSignal(db, ctx.merchantId, existing.as_of);
  const ruleResult = validateProposal({
    proposal: input.proposal,
    signal,
    budgetCapMinor: input.budgetCapMinor,
  });

  return db.transaction(async (tx) => {
    // Re-read under a row lock so two concurrent edits cannot both become "version N+1".
    const campaign = await loadCampaign(tx, ctx, input.campaignId, { forUpdate: true });
    if (["REPORTED", "EXPIRED", "FAILED"].includes(campaign.status)) {
      throw new AppError("RULE_VIOLATION", `A ${campaign.status} campaign cannot be revised.`);
    }
    const previous = await loadVersion(tx, campaign.id, campaign.current_version);
    const nextVersion = campaign.current_version + 1;
    const version = await writeVersion(tx, {
      ctx,
      campaignId: campaign.id,
      version: nextVersion,
      proposal: input.proposal,
      ruleResult,
      signal,
      capMinor: input.budgetCapMinor,
      aiSource: previous.ai_source,
    });

    // A changed plan cannot inherit an old authorization.
    const approvalsExpired = await tx.run(
      `UPDATE campaign_approval SET status = 'expired' WHERE campaign_id = $1 AND status = 'active'`,
      [campaign.id],
    );

    const jobsCancelled = await tx.run(
      `UPDATE delivery_job
          SET status = 'CANCELLED', cancel_reason = 'version_superseded', updated_at = $1
        WHERE campaign_id = $2 AND status = 'QUEUED'`,
      [new Date().toISOString(), campaign.id],
    );

    await tx.run(`UPDATE campaign SET current_version = $1, status = 'REVIEW', updated_at = $2 WHERE id = $3`, [
      nextVersion,
      new Date().toISOString(),
      campaign.id,
    ]);

    await recordAudit(tx, {
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
        approvals_expired: approvalsExpired,
        queued_jobs_cancelled: jobsCancelled,
        reward_minor: input.proposal.offer.amount_minor,
        estimated_cost_minor: ruleResult.estimated_cost_minor,
        rules_passed: ruleResult.eligible,
      },
    });

    await rememberFact(tx, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      kind: "revised",
      fact: `The merchant revised version ${campaign.current_version} to ₹${(input.proposal.offer.amount_minor / 100).toFixed(2)} (from ₹${(previous.proposal.offer.amount_minor / 100).toFixed(2)})${
        previous.proposal.copy.headline !== input.proposal.copy.headline || previous.proposal.copy.body !== input.proposal.copy.body ? " and edited the copy" : ""
      }; rules ${ruleResult.eligible ? "passed" : "still blocked it"}.`,
      details: { from_minor: previous.proposal.offer.amount_minor, to_minor: input.proposal.offer.amount_minor, passed: ruleResult.eligible },
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

export async function approveCampaign(db: Db, ctx: MerchantContext, input: ApproveInput): Promise<ApproveResult> {
  if (!input.idempotencyKey.trim()) {
    throw new AppError("BAD_REQUEST", "An Idempotency-Key header is required to approve a campaign.");
  }

  return db.transaction(async (tx) => {
    const campaign = await loadCampaign(tx, ctx, input.campaignId, { forUpdate: true });
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${campaign.id}|${input.version}`)
      .digest("hex");

    const priorByKey = await tx.one<{
      id: string;
      campaign_id: string;
      version_id: string;
      version: number;
      request_fingerprint: string;
    }>(`SELECT id, campaign_id, version_id, version, request_fingerprint FROM campaign_approval WHERE merchant_id = $1 AND idempotency_key = $2`, [
      ctx.merchantId,
      input.idempotencyKey,
    ]);

    if (priorByKey) {
      if (priorByKey.request_fingerprint !== fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used for a different approval request.",
        );
      }
      const jobs = await tx.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM delivery_job WHERE version_id = $1`, [
        priorByKey.version_id,
      ]);
      return {
        approvalId: priorByKey.id,
        versionId: priorByKey.version_id,
        version: priorByKey.version,
        status: campaign.status,
        jobsQueued: jobs?.n ?? 0,
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

    const version = await loadVersion(tx, campaign.id, input.version);
    const alreadyApproved = await tx.one(`SELECT id FROM campaign_approval WHERE version_id = $1 AND status = 'active'`, [
      version.id,
    ]);
    if (alreadyApproved) {
      throw new AppError("DUPLICATE_APPROVAL", "This version was already approved with a different key.");
    }

    // Re-run the same rules against fresh data: consent or eligibility may have
    // changed between preview and approval.
    const signal = await computeSignal(tx, ctx.merchantId, campaign.as_of);
    const proposal = version.proposal;
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

    const recipients = await listRecipients(tx, version.id);
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
    await tx.run(
      `INSERT INTO campaign_approval
         (id, campaign_id, merchant_id, version_id, version, approver, idempotency_key, request_fingerprint, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
      [approvalId, campaign.id, ctx.merchantId, version.id, version.version, ctx.actor, input.idempotencyKey, fingerprint, now],
    );

    // Only the campaign group is contacted. The holdout is the control and must
    // never receive a message, so it never gets a delivery job.
    const ordered = [...campaignGroup].sort((a, b) =>
      providerKeyFor(version.id, a.customer_id).localeCompare(providerKeyFor(version.id, b.customer_id)),
    );
    await tx.insertMany(
      "delivery_job",
      ["id", "merchant_id", "campaign_id", "version_id", "recipient_id", "customer_id", "status", "provider_key", "scenario_slot", "created_at", "updated_at"],
      ordered.map((recipient, slot) => [
        newId("job"),
        ctx.merchantId,
        campaign.id,
        version.id,
        recipient.id,
        recipient.customer_id,
        "QUEUED",
        providerKeyFor(version.id, recipient.customer_id),
        slot,
        now,
        now,
      ]),
    );

    await tx.run(`UPDATE campaign SET status = 'QUEUED', updated_at = $1 WHERE id = $2`, [now, campaign.id]);

    await recordAudit(tx, {
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

    await recordAudit(tx, {
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

    await rememberFact(tx, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      kind: "approved",
      fact: `Approved ₹${(proposal.offer.amount_minor / 100).toFixed(2)} for ${ruleResult.audience_count} absent regulars (${ordered.length} contacted, ${recipients.length - campaignGroup.length} held out) under a ₹${(version.cap_minor / 100).toFixed(2)} cap; validity ${proposal.offer.valid_days} days${proposal.offer.weekday_only ? ", weekdays only" : ""}.`,
      details: { reward_minor: proposal.offer.amount_minor, cap_minor: version.cap_minor, audience: ruleResult.audience_count, contacted: ordered.length },
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
