import type { SignalSummary } from "./signal";

export const OFFER_POLICY = {
  allowedKinds: ["fixed_reward"] as const,
  minRewardMinor: 100,
  maxRewardMinor: 10_000,
  allowedValidDays: [3, 5, 7, 10, 14] as const,
  earliestLocalHour: 8,
  latestLocalHour: 21,
  maxHeadlineChars: 90,
  maxBodyChars: 240,
  maxCtaChars: 40,
} as const;

export type Offer = {
  kind: "fixed_reward";
  amount_minor: number;
  valid_days: number;
  weekday_only: boolean;
};

export type Copy = {
  headline: string;
  body: string;
  cta: string;
};

export type Proposal = {
  copy_format?: "separate_reward";
  copy_source?: "model" | "template_fallback" | "merchant";
  comparison_explanation?: string;
  comparison_source?: "model" | "template_fallback";
  audience_label: string;
  offer: Offer;
  timing: { local_start: string; local_end: string };
  rationale: string[];
  copy: Copy;
  exclusions: string[];
  model_estimated_cost_minor: number | null;
};

export function rewardPromise(offer: Offer): string {
  return `Get ₹${(offer.amount_minor / 100).toFixed(2)} off one order${offer.weekday_only ? " on a weekday" : ""}. Valid for ${offer.valid_days} days.`;
}

export const COMPARISON_EXPLANATION = "A smaller reward limits maximum expenditure; a larger reward gives each contacted customer more. These options do not predict returns or profit.";

export function compareOffers(audienceCount: number, budgetCapMinor: number) {
  if (!Number.isSafeInteger(audienceCount) || audienceCount < 2 || !Number.isSafeInteger(budgetCapMinor) || budgetCapMinor <= 0) return [];
  const maximum = Math.min(Math.floor(budgetCapMinor / audienceCount), OFFER_POLICY.maxRewardMinor);
  const groups = splitGroups(audienceCount);
  return [...new Set([50, 75, 100].map((percent) => Math.floor(maximum * percent / 100)))]
    .filter((reward) => reward >= OFFER_POLICY.minRewardMinor)
    .map((reward) => ({
      reward_minor: reward,
      audience_count: audienceCount,
      campaign_group_size: groups.campaign,
      holdout_group_size: groups.holdout,
      conservative_exposure_minor: audienceCount * reward,
      campaign_exposure_minor: groups.campaign * reward,
    }));
}

export type OfferOption = ReturnType<typeof compareOffers>[number];

export type RuleError = { code: string; message: string; field?: string };

export type RuleResult = {
  eligible: boolean;
  audience_count: number;
  campaign_group_size: number;
  holdout_group_size: number;
  reward_minor: number;
  /**
   * Conservative pre-split exposure: the whole eligible cohort priced at the reward,
   * checked before the campaign/holdout split narrows who is actually contacted.
   */
  estimated_cost_minor: number;
  budget_cap_minor: number;
  /** Largest whole-paise reward that still fits the cap for this cohort size. */
  max_cap_safe_reward_minor: number;
  errors: RuleError[];
  warnings: string[];
  excluded: SignalSummary["excluded"];
};

/**
 * Copy that promises a different amount than the approved offer is a promise to
 * a customer the merchant will not keep. Only flagged when the copy quotes rupee
 * amounts and none of them is the actual reward, so "spend ₹200, get ₹15 off"
 * still passes.
 */
function copyContradictsOffer(copy: Copy, rewardMinor: number): boolean {
  const text = `${copy.headline} ${copy.body} ${copy.cta}`;
  const quoted = [...text.matchAll(/(?:₹|\bRs\.?\s?)\s?(\d+(?:\.\d{1,2})?)/gi)].map((match) =>
    Math.round(Number.parseFloat(match[1]!) * 100),
  );
  if (quoted.length === 0) return false;
  return !quoted.includes(rewardMinor);
}

function parseLocalTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function splitGroups(audienceCount: number): { campaign: number; holdout: number } {
  const campaign = Math.floor(audienceCount / 2);
  return { campaign, holdout: audienceCount - campaign };
}

/**
 * The single validation path. Preview, revision, approval and the worker's
 * pre-send check all call this, so a guard can never drift between routes.
 */
export function validateProposal(input: {
  proposal: Proposal;
  signal: SignalSummary;
  budgetCapMinor: number;
}): RuleResult {
  const { proposal, signal, budgetCapMinor } = input;
  const errors: RuleError[] = [];
  const warnings: string[] = [];

  const audienceCount = signal.eligibleCount;
  const rewardMinor = Number.isInteger(proposal.offer.amount_minor) ? proposal.offer.amount_minor : 0;
  const estimatedCostMinor = audienceCount * rewardMinor;
  const groups = splitGroups(audienceCount);

  if (audienceCount < 2) {
    errors.push({
      code: "NO_ELIGIBLE_COHORT",
      message:
        "At least two eligible customers are required for a campaign and an untouched holdout.",
    });
  }

  if (!(OFFER_POLICY.allowedKinds as readonly string[]).includes(proposal.offer.kind)) {
    errors.push({
      code: "OFFER_KIND_NOT_ALLOWED",
      message: `Offer type "${proposal.offer.kind}" is outside policy ${signal.policy.version}.`,
      field: "offer.kind",
    });
  }

  if (
    !Number.isInteger(rewardMinor) ||
    rewardMinor < OFFER_POLICY.minRewardMinor ||
    rewardMinor > OFFER_POLICY.maxRewardMinor
  ) {
    errors.push({
      code: "OFFER_AMOUNT_OUT_OF_BOUNDS",
      message: `Reward must be a whole paise amount between ₹${OFFER_POLICY.minRewardMinor / 100} and ₹${
        OFFER_POLICY.maxRewardMinor / 100
      }.`,
      field: "offer.amount_minor",
    });
  }

  if (!(OFFER_POLICY.allowedValidDays as readonly number[]).includes(proposal.offer.valid_days)) {
    errors.push({
      code: "OFFER_VALIDITY_NOT_ALLOWED",
      message: `Validity must be one of ${OFFER_POLICY.allowedValidDays.join(", ")} days.`,
      field: "offer.valid_days",
    });
  }

  const start = parseLocalTime(proposal.timing.local_start);
  const end = parseLocalTime(proposal.timing.local_end);
  if (start === null || end === null || start >= end) {
    errors.push({
      code: "TIMING_INVALID",
      message: "Timing must be HH:MM with a start earlier than the end.",
      field: "timing",
    });
  } else if (
    start < OFFER_POLICY.earliestLocalHour * 60 ||
    end > OFFER_POLICY.latestLocalHour * 60
  ) {
    errors.push({
      code: "TIMING_OUTSIDE_POLICY",
      message: `Timing must sit between ${OFFER_POLICY.earliestLocalHour}:00 and ${OFFER_POLICY.latestLocalHour}:00 local time.`,
      field: "timing",
    });
  }

  if (proposal.copy.headline.length > OFFER_POLICY.maxHeadlineChars) {
    errors.push({ code: "COPY_TOO_LONG", message: "Headline is too long.", field: "copy.headline" });
  }
  if (proposal.copy.body.length > OFFER_POLICY.maxBodyChars) {
    errors.push({ code: "COPY_TOO_LONG", message: "Body is too long.", field: "copy.body" });
  }
  if (proposal.copy.cta.length > OFFER_POLICY.maxCtaChars) {
    errors.push({ code: "COPY_TOO_LONG", message: "Call to action is too long.", field: "copy.cta" });
  }
  if (!proposal.copy.headline.trim() || !proposal.copy.body.trim() || !proposal.copy.cta.trim()) {
    errors.push({ code: "COPY_EMPTY", message: "Campaign copy cannot be empty.", field: "copy" });
  }

  if (copyContradictsOffer(proposal.copy, rewardMinor)) {
    errors.push({
      code: "COPY_OFFER_MISMATCH",
      message: `The message quotes a rupee amount that is not the ₹${(rewardMinor / 100).toFixed(
        2,
      )} reward. Update the copy so it promises what the offer actually gives.`,
      field: "copy.body",
    });
  }

  if (proposal.copy_format === "separate_reward" && /[\d₹%]|\b(?:INR|Rs|rupees?)\b/i.test(Object.values(proposal.copy).join(" "))) {
    errors.push({ code: "COPY_OFFER_MISMATCH", message: "Keep amounts and numeric terms in the generated offer sentence, not the editable introduction.", field: "copy" });
  }

  if (!Number.isInteger(budgetCapMinor) || budgetCapMinor <= 0) {
    errors.push({
      code: "BUDGET_CAP_INVALID",
      message: "Budget cap must be a positive whole paise amount.",
      field: "budget_cap_minor",
    });
  } else if (estimatedCostMinor > budgetCapMinor) {
    errors.push({
      code: "BUDGET_EXCEEDED",
      message: `Estimated reward exposure is ₹${(estimatedCostMinor / 100).toFixed(
        2,
      )} for ${audienceCount} eligible customers, which exceeds the ₹${(budgetCapMinor / 100).toFixed(2)} cap.`,
      field: "offer.amount_minor",
    });
  }

  if (
    proposal.model_estimated_cost_minor !== null &&
    proposal.model_estimated_cost_minor !== estimatedCostMinor
  ) {
    warnings.push(
      `The model estimated ₹${(proposal.model_estimated_cost_minor / 100).toFixed(2)}; rules recomputed ₹${(
        estimatedCostMinor / 100
      ).toFixed(2)} and the rule figure is authoritative.`,
    );
  }

  warnings.push("Contribution is a payment-volume proxy; merchant margin and messaging cost are unavailable.");

  if (signal.excluded.consent_false + signal.excluded.consent_unknown > 0) {
    warnings.push(
      `${signal.excluded.consent_false + signal.excluded.consent_unknown} absent regulars are excluded because consent is false or unknown.`,
    );
  }

  return {
    eligible: errors.length === 0,
    audience_count: audienceCount,
    campaign_group_size: groups.campaign,
    holdout_group_size: groups.holdout,
    reward_minor: rewardMinor,
    estimated_cost_minor: estimatedCostMinor,
    budget_cap_minor: budgetCapMinor,
    max_cap_safe_reward_minor:
      audienceCount > 0 && budgetCapMinor > 0 ? Math.floor(budgetCapMinor / audienceCount) : 0,
    errors,
    warnings,
    excluded: signal.excluded,
  };
}
