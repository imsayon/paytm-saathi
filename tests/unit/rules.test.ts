import assert from "node:assert/strict";
import { test } from "node:test";
import { splitGroups, validateProposal } from "../../src/server/domain/rules";
import { computeSignal, type SignalSummary } from "../../src/server/domain/signal";
import { absentRegularRows, AS_OF, importRows, proposalOf, seedMerchant, tempDb } from "../helpers";

function signalWith(count: number): SignalSummary {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(
    db,
    ctx,
    Array.from({ length: count }, (_, index) => absentRegularRows(`C${String(index).padStart(2, "0")}`)).flat(),
  );
  return computeSignal(db, ctx.merchantId, AS_OF);
}

const TWENTY = signalWith(20);

test("exposure is cohort size times reward, in integer paise", () => {
  const result = validateProposal({
    proposal: proposalOf({ offer: { kind: "fixed_reward", amount_minor: 1500, valid_days: 7, weekday_only: true } }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });

  assert.equal(result.audience_count, 20);
  assert.equal(result.estimated_cost_minor, 30_000);
  assert.equal(result.eligible, true);
});

test("a reward that exceeds the cap is rejected and suggests the cap-safe amount", () => {
  const result = validateProposal({
    proposal: proposalOf({ offer: { kind: "fixed_reward", amount_minor: 2500, valid_days: 7, weekday_only: true } }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.estimated_cost_minor, 50_000);
  assert.ok(result.errors.some((error) => error.code === "BUDGET_EXCEEDED"));
  assert.equal(result.max_cap_safe_reward_minor, 1500);
});

test("exposure exactly equal to the cap is allowed", () => {
  const result = validateProposal({
    proposal: proposalOf(),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });
  assert.equal(result.eligible, true);
});

test("an empty cohort blocks the campaign", () => {
  const result = validateProposal({ proposal: proposalOf(), signal: signalWith(0), budgetCapMinor: 30_000 });
  assert.equal(result.eligible, false);
  assert.ok(result.errors.some((error) => error.code === "NO_ELIGIBLE_COHORT"));
});

test("rewards outside policy bounds are rejected", () => {
  for (const amount of [0, 50, 20_000]) {
    const result = validateProposal({
      proposal: proposalOf({ offer: { kind: "fixed_reward", amount_minor: amount, valid_days: 7, weekday_only: true } }),
      signal: TWENTY,
      budgetCapMinor: 10_000_000,
    });
    assert.ok(
      result.errors.some((error) => error.code === "OFFER_AMOUNT_OUT_OF_BOUNDS"),
      `₹${amount / 100} should be out of bounds`,
    );
  }
});

test("timing outside the allowed window is rejected", () => {
  const early = validateProposal({
    proposal: proposalOf({ timing: { local_start: "05:00", local_end: "07:00" } }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });
  assert.ok(early.errors.some((error) => error.code === "TIMING_OUTSIDE_POLICY"));

  const backwards = validateProposal({
    proposal: proposalOf({ timing: { local_start: "16:00", local_end: "11:00" } }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });
  assert.ok(backwards.errors.some((error) => error.code === "TIMING_INVALID"));
});

test("copy that promises an amount other than the reward is rejected", () => {
  const result = validateProposal({
    proposal: proposalOf({
      copy: {
        headline: "A treat for you",
        body: "Come back this week and enjoy ₹25 off your order.",
        cta: "Visit this week",
      },
    }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });

  assert.equal(result.eligible, false);
  assert.ok(result.errors.some((error) => error.code === "COPY_OFFER_MISMATCH"));
});

test("copy may quote other amounts as long as it also states the real reward", () => {
  const result = validateProposal({
    proposal: proposalOf({
      copy: {
        headline: "A treat for you",
        body: "Spend ₹200 this week and enjoy ₹15 off your order.",
        cta: "Visit this week",
      },
    }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });

  assert.equal(result.eligible, true);
});

test("a model cost estimate that disagrees with the rules is recorded as a warning, not trusted", () => {
  const result = validateProposal({
    proposal: proposalOf({ model_estimated_cost_minor: 999 }),
    signal: TWENTY,
    budgetCapMinor: 30_000,
  });

  assert.equal(result.estimated_cost_minor, 30_000);
  assert.equal(result.eligible, true);
  assert.ok(result.warnings.some((warning) => warning.includes("rule figure is authoritative")));
});

test("an invalid budget cap is rejected", () => {
  const result = validateProposal({ proposal: proposalOf(), signal: TWENTY, budgetCapMinor: 0 });
  assert.ok(result.errors.some((error) => error.code === "BUDGET_CAP_INVALID"));
});

test("groups split evenly, with the odd customer held out", () => {
  assert.deepEqual(splitGroups(20), { campaign: 10, holdout: 10 });
  assert.deepEqual(splitGroups(7), { campaign: 3, holdout: 4 });
  assert.deepEqual(splitGroups(0), { campaign: 0, holdout: 0 });
});
