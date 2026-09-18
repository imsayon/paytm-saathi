import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../../src/server/domain/measurement";
import { seedMerchant, tempDb } from "../helpers";

type OutcomeSpec = { group: "campaign" | "holdout"; returned: boolean; amount?: number; reward?: number; optedOut?: boolean };

function reportFor(specs: OutcomeSpec[]) {
  const db = tempDb();
  const ctx = seedMerchant(db);
  const campaignId = "cmp_test";
  const versionId = "ver_test";
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO campaign (id, merchant_id, intent, status, current_version, as_of, created_at, updated_at)
     VALUES (?, ?, 'test', 'REPORTED', 1, '2026-09-01', ?, ?)`,
  ).run(campaignId, ctx.merchantId, now, now);
  db.prepare(
    `INSERT INTO campaign_version
       (id, campaign_id, merchant_id, version, proposal_json, rule_result_json, cohort_hash, cap_minor, policy_version, ai_source, created_by, created_at)
     VALUES (?, ?, ?, 1, '{}', '{}', 'hash', 30000, 'retention-v1', 'template_fallback', 'test', ?)`,
  ).run(versionId, campaignId, ctx.merchantId, now);

  specs.forEach((_, index) => {
    db.prepare(
      `INSERT INTO customer (id, merchant_id, external_id, display_name, contact_ref, created_at)
       VALUES (?, ?, ?, ?, 'ref', ?)`,
    ).run(`cus_${index}`, ctx.merchantId, `C${index}`, `Synthetic C${index}`, now);
  });

  specs.forEach((spec, index) => {
    db.prepare(
      `INSERT INTO outcome
         (id, merchant_id, campaign_id, version_id, customer_id, assignment_group, returned, return_at,
          settled_amount_minor, reward_cost_minor, opted_out, window_start, window_end, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '2026-09-02', '2026-09-09', 1)`,
    ).run(
      `out_${index}`,
      ctx.merchantId,
      campaignId,
      versionId,
      `cus_${index}`,
      spec.group,
      spec.returned ? 1 : 0,
      spec.returned ? (spec.amount ?? 18_000) : 0,
      spec.reward ?? 0,
      spec.optedOut ? 1 : 0,
    );
  });

  return buildReport(db, campaignId, versionId);
}

test("the documented fixture scenario reproduces every headline number", () => {
  const specs: OutcomeSpec[] = [
    ...Array.from({ length: 6 }, () => ({ group: "campaign" as const, returned: true, reward: 1500 })),
    ...Array.from({ length: 4 }, () => ({ group: "campaign" as const, returned: false })),
    ...Array.from({ length: 2 }, () => ({ group: "holdout" as const, returned: true })),
    ...Array.from({ length: 8 }, () => ({ group: "holdout" as const, returned: false })),
  ];

  const report = reportFor(specs);

  assert.equal(report.campaign.return_rate, 0.6);
  assert.equal(report.holdout.return_rate, 0.2);
  assert.equal(report.observed_lift_pp, 40);
  assert.equal(report.expected_incremental_returns, 4);
  assert.equal(report.campaign.return_volume_minor, 108_000);
  assert.equal(report.expected_campaign_baseline_volume_minor, 36_000);
  assert.equal(report.incremental_payment_volume_minor, 72_000);
  assert.equal(report.reward_cost_minor, 9_000);
  assert.equal(report.contribution_proxy_minor, 63_000);
});

test("an empty campaign reports zero rates instead of dividing by zero", () => {
  const report = reportFor([]);
  assert.equal(report.has_outcomes, false);
  assert.equal(report.campaign.return_rate, 0);
  assert.equal(report.holdout.return_rate, 0);
  assert.equal(report.observed_lift_pp, 0);
});

test("a holdout that outperforms the campaign reports a negative difference honestly", () => {
  const report = reportFor([
    { group: "campaign", returned: true, reward: 1500 },
    { group: "campaign", returned: false },
    { group: "holdout", returned: true },
    { group: "holdout", returned: true },
  ]);

  assert.equal(report.campaign.return_rate, 0.5);
  assert.equal(report.holdout.return_rate, 1);
  assert.equal(report.observed_lift_pp, -50);
  assert.ok(report.contribution_proxy_minor < 0);
});

test("opt-outs are counted across both groups", () => {
  const report = reportFor([
    { group: "campaign", returned: false, optedOut: true },
    { group: "campaign", returned: true, reward: 1500 },
    { group: "holdout", returned: false },
  ]);
  assert.equal(report.opt_outs, 1);
});

test("the report always carries the synthetic and proxy caveats", () => {
  const report = reportFor([{ group: "campaign", returned: true, reward: 1500 }]);
  assert.ok(report.caveats.some((caveat) => caveat.toLowerCase().includes("synthetic")));
  assert.ok(report.caveats.some((caveat) => caveat.toLowerCase().includes("not profit")));
  assert.ok(Object.keys(report.formulas).length >= 5);
});
