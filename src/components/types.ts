export type Proposal = {
  audience_label: string;
  offer: { kind: string; amount_minor: number; valid_days: number; weekday_only: boolean };
  timing: { local_start: string; local_end: string };
  rationale: string[];
  copy: { headline: string; body: string; cta: string };
  exclusions: string[];
  model_estimated_cost_minor: number | null;
};

export type RuleResult = {
  eligible: boolean;
  audience_count: number;
  campaign_group_size: number;
  holdout_group_size: number;
  reward_minor: number;
  estimated_cost_minor: number;
  budget_cap_minor: number;
  max_cap_safe_reward_minor: number;
  errors: { code: string; message: string; field?: string }[];
  warnings: string[];
  excluded: Record<string, number>;
};

export type JobView = {
  job_id: string;
  customer_ref: string;
  status: string;
  attempts: number;
  provider_key: string;
  cancel_reason: string | null;
  attempt_log: { attempt_no: number; outcome: string; provider_message_id: string | null; finished_at: string }[];
};

export type MeasurementReport = {
  has_outcomes: boolean;
  window_start: string | null;
  window_end: string | null;
  campaign: { size: number; returns: number; return_rate: number; return_volume_minor: number };
  holdout: { size: number; returns: number; return_rate: number; return_volume_minor: number };
  observed_lift_pp: number;
  expected_incremental_returns: number;
  expected_campaign_baseline_volume_minor: number;
  incremental_payment_volume_minor: number;
  reward_cost_minor: number;
  contribution_proxy_minor: number;
  opt_outs: number;
  delivery_errors: number;
  average_return_amount_minor: number;
  formulas: Record<string, string>;
  caveats: string[];
};

export type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  entity: string;
  details: unknown;
  created_at: string;
};

export type CampaignDetail = {
  campaign: {
    id: string;
    intent: string;
    status: string;
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
    ai_source: "model" | "template_fallback";
    policy_version: string;
    cohort_hash: string;
    budget_cap_minor: number;
    created_at: string;
  };
  proposal: Proposal;
  rule_result: RuleResult;
  rule_result_at_creation?: RuleResult;
  approval: { id: string; version: number; approver: string; created_at: string } | null;
  groups: { campaign: string[]; holdout: string[] };
  jobs: JobView[];
  job_summary: Record<string, number>;
  report: MeasurementReport;
  audit: AuditEvent[];
  provider: { name: string; live: boolean };
  planner?: { source: string; fallback_reason: string | null; latency_ms: number; model: string | null };
};
