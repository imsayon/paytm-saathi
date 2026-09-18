import assert from "node:assert/strict";
import { test } from "node:test";
import { templateProposal, buildPlannerInput } from "../../src/server/ai/planner";
import { plannerOutputSchema } from "../../src/server/ai/schema";
import type { Db } from "../../src/server/db/client";
import {
  approveCampaign,
  createCampaignPreview,
  listRecipients,
  loadCampaign,
  reviseCampaign,
} from "../../src/server/domain/campaign";
import { computeSignal } from "../../src/server/domain/signal";
import { AppError } from "../../src/server/errors";
import { absentRegularRows, AS_OF, importRows, proposalOf, seedMerchant, tempDb } from "../helpers";
import type { MerchantContext } from "../../src/server/auth/context";

function setup(customerCount = 20): { db: Db; ctx: MerchantContext } {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(
    db,
    ctx,
    Array.from({ length: customerCount }, (_, index) => absentRegularRows(`C${String(index).padStart(2, "0")}`)).flat(),
  );
  return { db, ctx };
}

function previewOf(db: Db, ctx: MerchantContext, rewardMinor = 1500) {
  return createCampaignPreview(db, ctx, {
    intent: "Bring back my weekday regulars.",
    budgetCapMinor: 30_000,
    asOf: AS_OF,
    proposal: proposalOf({
      offer: { kind: "fixed_reward", amount_minor: rewardMinor, valid_days: 7, weekday_only: true },
    }),
    aiSource: "template_fallback",
    fallbackReason: "no_api_key",
  });
}

test("importing the same file twice publishes one batch", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  const rows = [...absentRegularRows("C00"), ...absentRegularRows("C01")];

  importRows(db, ctx, rows);
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM payment`).get() as { n: number }).n;

  const second = importRows(db, ctx, rows);
  assert.equal(second.alreadyImported, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM payment`).get() as { n: number }).n, before);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM import_batch`).get() as { n: number }).n, 1);
});

test("a row belonging to another merchant is refused", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  assert.throws(
    () => importRows(db, ctx, [{ customer: "C1", date: "2026-07-14", merchant: "someone_else" }]),
    (error: AppError) => error.code === "FORBIDDEN",
  );
});

test("preview stores one version, recipients split into two groups, and no delivery job", () => {
  const { db, ctx } = setup();
  const { campaignId, version, ruleResult } = previewOf(db, ctx);

  assert.equal(version.version, 1);
  assert.equal(ruleResult.eligible, true);

  const recipients = listRecipients(db, version.id);
  assert.equal(recipients.length, 20);
  assert.equal(recipients.filter((r) => r.assignment_group === "campaign").length, 10);
  assert.equal(recipients.filter((r) => r.assignment_group === "holdout").length, 10);

  const jobs = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_job`).get() as { n: number }).n;
  assert.equal(jobs, 0, "preview must never create a delivery job");
  assert.equal(loadCampaign(db, ctx, campaignId).status, "REVIEW");
});

test("an over-cap proposal is stored as blocked and cannot be approved", () => {
  const { db, ctx } = setup();
  const { campaignId, ruleResult } = previewOf(db, ctx, 2500);

  assert.equal(ruleResult.eligible, false);
  assert.equal(ruleResult.estimated_cost_minor, 50_000);

  assert.throws(
    () => approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "k1" }),
    (error: AppError) => error.code === "RULE_VIOLATION",
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM delivery_job`).get() as { n: number }).n, 0);
});

test("revision creates a new immutable version and leaves the old one readable", () => {
  const { db, ctx } = setup();
  const { campaignId, version } = previewOf(db, ctx, 2500);

  const revised = reviseCampaign(db, ctx, {
    campaignId,
    proposal: proposalOf(),
    budgetCapMinor: 30_000,
  });

  assert.equal(revised.version.version, 2);
  assert.equal(loadCampaign(db, ctx, campaignId).current_version, 2);
  const original = db.prepare(`SELECT proposal_json FROM campaign_version WHERE id = ?`).get(version.id) as {
    proposal_json: string;
  };
  assert.equal(JSON.parse(original.proposal_json).offer.amount_minor, 2500, "version 1 must not be mutated");
});

test("approving a stale version is refused", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx, 2500);
  reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });

  assert.throws(
    () => approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "stale" }),
    (error: AppError) => error.code === "STALE_VERSION",
  );
});

test("approval creates one job per campaign recipient and none for the holdout", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);

  const result = approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "ok" });
  assert.equal(result.jobsQueued, 10);
  assert.equal(result.status, "QUEUED");

  const holdoutJobs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_job j
         JOIN campaign_recipient r ON r.id = j.recipient_id
        WHERE r.assignment_group = 'holdout'`,
    )
    .get() as { n: number };
  assert.equal(holdoutJobs.n, 0, "the holdout is the control and must never be contacted");

  const keys = db.prepare(`SELECT DISTINCT provider_key FROM delivery_job`).all() as unknown[];
  assert.equal(keys.length, 10, "each job carries its own stable provider idempotency key");
});

test("replaying the same idempotency key returns the original approval without new jobs", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);

  const first = approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "same" });
  const second = approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "same" });

  assert.equal(second.approvalId, first.approvalId);
  assert.equal(second.replayed, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM delivery_job`).get() as { n: number }).n, 10);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM campaign_approval`).get() as { n: number }).n, 1);
});

test("a second key against an approved version conflicts", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);
  approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "first" });

  assert.throws(
    () => approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "second" }),
    (error: AppError) => error.code === "DUPLICATE_APPROVAL",
  );
});

test("reusing a key for a different request is an idempotency conflict", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);
  approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "shared" });
  reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });

  assert.throws(
    () => approveCampaign(db, ctx, { campaignId, version: 2, idempotencyKey: "shared" }),
    (error: AppError) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("revising after approval expires the approval and cancels queued jobs", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);
  approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "approve" });

  reviseCampaign(db, ctx, { campaignId, proposal: proposalOf({ audience_label: "Edited" }), budgetCapMinor: 30_000 });

  const active = db.prepare(`SELECT COUNT(*) AS n FROM campaign_approval WHERE status = 'active'`).get() as {
    n: number;
  };
  const cancelled = db.prepare(`SELECT COUNT(*) AS n FROM delivery_job WHERE status = 'CANCELLED'`).get() as {
    n: number;
  };
  assert.equal(active.n, 0);
  assert.equal(cancelled.n, 10);
});

test("consent withdrawn between preview and approval blocks approval and queues nothing", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);

  const customer = db.prepare(`SELECT id FROM customer LIMIT 1`).get() as { id: string };
  db.prepare(
    `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES (?, ?, ?, 'false', 'test', ?)`,
  ).run("con_revoked", ctx.merchantId, customer.id, new Date().toISOString());

  assert.throws(
    () => approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "after-revoke" }),
    (error: AppError) => error.code === "RULE_VIOLATION",
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM delivery_job`).get() as { n: number }).n, 0);
});

test("another merchant cannot read or approve this campaign", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx);
  const intruder = seedMerchant(db, "mch_intruder", "Other merchant");

  assert.throws(() => loadCampaign(db, intruder, campaignId), (error: AppError) => error.code === "FORBIDDEN");
  assert.throws(
    () => approveCampaign(db, intruder, { campaignId, version: 1, idempotencyKey: "intruder" }),
    (error: AppError) => error.code === "FORBIDDEN",
  );
});

test("every material transition writes an audit event", () => {
  const { db, ctx } = setup();
  const { campaignId } = previewOf(db, ctx, 2500);
  reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });
  approveCampaign(db, ctx, { campaignId, version: 2, idempotencyKey: "audited" });

  const actions = (
    db.prepare(`SELECT action FROM audit_event WHERE campaign_id = ? ORDER BY rowid`).all(campaignId) as {
      action: string;
    }[]
  ).map((row) => row.action);

  assert.deepEqual(actions, ["campaign.created", "campaign.version_changed", "campaign.approved", "jobs.queued"]);
});

test("the planner never receives contact references or customer identifiers", () => {
  const { db, ctx } = setup();
  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  const input = buildPlannerInput({
    intent: "Bring back my weekday regulars.",
    signal,
    budgetCapMinor: 30_000,
    timezone: "Asia/Kolkata",
  });

  const serialized = JSON.stringify(input);
  assert.ok(!serialized.includes("synthetic-sms"), "no contact reference may reach the planner");
  assert.ok(!serialized.includes("C00"), "no customer identifier may reach the planner");
  assert.equal(input.eligible_count, 20);
});

test("the template fallback produces a schema-valid proposal without a model", () => {
  const { db, ctx } = setup();
  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  const proposal = templateProposal(
    buildPlannerInput({ intent: "x", signal, budgetCapMinor: 30_000, timezone: "Asia/Kolkata" }),
  );

  const parsed = plannerOutputSchema.safeParse({
    ...proposal,
    estimated_cost_minor: 0,
  });
  assert.equal(parsed.success, true);
});

test("planner output that breaks the schema is rejected before it reaches the rules", () => {
  const parsed = plannerOutputSchema.safeParse({
    audience_label: "x",
    offer: { kind: "free_meal", amount_minor: 100, valid_days: 7, weekday_only: true },
    timing: { local_start: "11:00", local_end: "16:00" },
    rationale: ["ok"],
    copy: { headline: "aaa", body: "bbb", cta: "cc" },
    estimated_cost_minor: 0,
    exclusions: [],
  });
  assert.equal(parsed.success, false, "an offer type outside policy must not parse");
});
