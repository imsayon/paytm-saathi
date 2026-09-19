import assert from "node:assert/strict";
import { runPlanner, type PlannerInput } from "../src/server/ai/planner";
import { compareOffers, OFFER_POLICY } from "../src/server/domain/rules";
import { RETENTION_POLICY } from "../src/server/domain/signal";

// Synthetic aggregate-only probe; no database writes or customer contact.
const input: PlannerInput = {
  merchant_intent: "Welcome back our absent regulars with an affordable weekday reward.",
  merchant_timezone: "Asia/Kolkata", eligible_count: 20, weekday_count: 20,
  inactive_days: 21, budget_cap_minor: 30000, allowed_offer: "fixed_reward",
  allowed_valid_days: OFFER_POLICY.allowedValidDays, policy_version: RETENTION_POLICY.version,
  excluded_counts: { consent_false: 2, consent_unknown: 2, no_contact_ref: 0, over_cohort_cap: 0 },
  offer_options: compareOffers(20, 30000), merchant_memory: [],
};
const result = await runPlanner(input);
console.log(JSON.stringify({ source: result.source, model: result.model, latency_ms: result.latencyMs,
  fallback_reason: result.fallbackReason, explanation_source: result.proposal.comparison_source,
  contact_data_sent: false, provider_calls: 0 }));
assert.equal(result.source, "model", "Live Gemini verification failed; template fallback remains available.");
assert.equal(result.proposal.copy_source, "model");
