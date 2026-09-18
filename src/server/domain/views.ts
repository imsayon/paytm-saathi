import { listAudit } from "../audit/events";
import type { MerchantContext } from "../auth/context";
import type { Db } from "../db/client";
import { listRecipients, loadCampaign, loadVersion, type CampaignRow, type VersionRow } from "./campaign";
import { buildReport, type MeasurementReport } from "./measurement";
import { validateProposal, type Proposal, type RuleResult } from "./rules";
import { computeSignal, type CustomerSignal, type SignalSummary } from "./signal";

/** Customer identifiers are masked everywhere they leave the server. */
export function maskCustomer(externalId: string): string {
  if (externalId.length <= 4) return `${externalId.slice(0, 1)}***`;
  return `${externalId.slice(0, 5)}***${externalId.slice(-2)}`;
}

export type CustomerView = {
  customer_ref: string;
  consent: CustomerSignal["consent"];
  settled_visits: number;
  distinct_dates: number;
  last_settled_date: string | null;
  days_since_last_visit: number | null;
  weekday_regular: boolean;
  eligible: boolean;
  exclusion_reason: string | null;
};

export function toCustomerView(signal: CustomerSignal): CustomerView {
  return {
    customer_ref: maskCustomer(signal.externalId),
    consent: signal.consent,
    settled_visits: signal.settledVisits,
    distinct_dates: signal.distinctDates,
    last_settled_date: signal.lastSettledDate,
    days_since_last_visit: signal.daysSinceLastVisit,
    weekday_regular: signal.isWeekdayRegular,
    eligible: signal.eligible,
    exclusion_reason: signal.exclusionReason,
  };
}

export function signalView(signal: SignalSummary) {
  return {
    as_of: signal.asOf,
    policy: signal.policy,
    total_customers: signal.totalCustomers,
    regular_customers: signal.regularCustomers,
    absent_regulars: signal.absentRegulars,
    eligible_count: signal.eligibleCount,
    cohort_hash: signal.cohortHash,
    excluded: signal.excluded,
    absent_customers: signal.absent.map(toCustomerView),
  };
}

export type JobView = {
  job_id: string;
  customer_ref: string;
  status: string;
  attempts: number;
  provider_key: string;
  cancel_reason: string | null;
  attempt_log: { attempt_no: number; outcome: string; provider_message_id: string | null; finished_at: string }[];
};

export function listJobViews(db: Db, versionId: string): JobView[] {
  const jobs = db
    .prepare(
      `SELECT j.id, j.status, j.attempt_count, j.provider_key, j.cancel_reason, c.external_id
         FROM delivery_job j
         JOIN customer c ON c.id = j.customer_id
        WHERE j.version_id = ?
        ORDER BY j.scenario_slot`,
    )
    .all(versionId) as {
    id: string;
    status: string;
    attempt_count: number;
    provider_key: string;
    cancel_reason: string | null;
    external_id: string;
  }[];

  const attempts = db
    .prepare(
      `SELECT a.job_id, a.attempt_no, a.outcome, a.provider_message_id, a.finished_at
         FROM delivery_attempt a
         JOIN delivery_job j ON j.id = a.job_id
        WHERE j.version_id = ?
        ORDER BY a.attempt_no`,
    )
    .all(versionId) as {
    job_id: string;
    attempt_no: number;
    outcome: string;
    provider_message_id: string | null;
    finished_at: string;
  }[];

  return jobs.map((job) => ({
    job_id: job.id,
    customer_ref: maskCustomer(job.external_id),
    status: job.status,
    attempts: job.attempt_count,
    provider_key: job.provider_key,
    cancel_reason: job.cancel_reason,
    attempt_log: attempts
      .filter((attempt) => attempt.job_id === job.id)
      .map(({ attempt_no, outcome, provider_message_id, finished_at }) => ({
        attempt_no,
        outcome,
        provider_message_id,
        finished_at,
      })),
  }));
}

export type CampaignDetail = {
  campaign: {
    id: string;
    intent: string;
    status: CampaignRow["status"];
    current_version: number;
    as_of: string;
    window_start: string | null;
    window_end: string | null;
    created_at: string;
    updated_at: string;
  };
  version: {
    id: string;
    version: number;
    ai_source: VersionRow["ai_source"];
    policy_version: string;
    cohort_hash: string;
    budget_cap_minor: number;
    created_at: string;
  };
  proposal: Proposal;
  /** Re-evaluated against current data, so the screen cannot disagree with approval. */
  rule_result: RuleResult;
  /** Immutable record of what was validated when the version was written. */
  rule_result_at_creation: RuleResult;
  approval: { id: string; version: number; approver: string; created_at: string } | null;
  groups: { campaign: string[]; holdout: string[] };
  jobs: JobView[];
  job_summary: Record<string, number>;
  signal: ReturnType<typeof signalView>;
  report: MeasurementReport;
  audit: { id: string; action: string; actor: string; entity: string; details: unknown; created_at: string }[];
  provider: { name: string; live: boolean };
};

export function buildCampaignDetail(db: Db, ctx: MerchantContext, campaignId: string): CampaignDetail {
  const campaign = loadCampaign(db, ctx, campaignId);
  const version = loadVersion(db, campaign.id, campaign.current_version);
  const recipients = listRecipients(db, version.id);
  const signal = computeSignal(db, ctx.merchantId, campaign.as_of);
  const proposal = JSON.parse(version.proposal_json) as Proposal;

  const externalIdById = new Map(
    (
      db.prepare(`SELECT id, external_id FROM customer WHERE merchant_id = ?`).all(ctx.merchantId) as {
        id: string;
        external_id: string;
      }[]
    ).map((row) => [row.id, row.external_id]),
  );

  const approval = db
    .prepare(
      `SELECT id, version, approver, created_at FROM campaign_approval WHERE campaign_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(campaign.id) as { id: string; version: number; approver: string; created_at: string } | undefined;

  const jobs = listJobViews(db, version.id);
  const jobSummary = jobs.reduce<Record<string, number>>((summary, job) => {
    summary[job.status] = (summary[job.status] ?? 0) + 1;
    return summary;
  }, {});

  return {
    campaign: {
      id: campaign.id,
      intent: campaign.intent,
      status: campaign.status,
      current_version: campaign.current_version,
      as_of: campaign.as_of,
      window_start: campaign.window_start,
      window_end: campaign.window_end,
      created_at: campaign.created_at,
      updated_at: campaign.updated_at,
    },
    version: {
      id: version.id,
      version: version.version,
      ai_source: version.ai_source,
      policy_version: version.policy_version,
      cohort_hash: version.cohort_hash,
      budget_cap_minor: version.cap_minor,
      created_at: version.created_at,
    },
    proposal,
    rule_result: validateProposal({ proposal, signal, budgetCapMinor: version.cap_minor }),
    rule_result_at_creation: JSON.parse(version.rule_result_json) as RuleResult,
    approval: approval ?? null,
    groups: {
      campaign: recipients
        .filter((recipient) => recipient.assignment_group === "campaign")
        .map((recipient) => maskCustomer(externalIdById.get(recipient.customer_id) ?? recipient.customer_id)),
      holdout: recipients
        .filter((recipient) => recipient.assignment_group === "holdout")
        .map((recipient) => maskCustomer(externalIdById.get(recipient.customer_id) ?? recipient.customer_id)),
    },
    jobs,
    job_summary: jobSummary,
    signal: signalView(signal),
    report: buildReport(db, campaign.id, version.id),
    audit: listAudit(db, ctx.merchantId, campaign.id).map((event) => ({
      id: event.id,
      action: event.action,
      actor: event.actor,
      entity: event.entity,
      details: JSON.parse(event.details_json),
      created_at: event.created_at,
    })),
    provider: { name: "mock", live: false },
  };
}
