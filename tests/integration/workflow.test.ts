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
import { absentRegularRows, AS_OF, count, importRows, proposalOf, seedMerchant, tempDb } from "../helpers";
import type { MerchantContext } from "../../src/server/auth/context";

async function setup(customerCount = 20): Promise<{ db: Db; ctx: MerchantContext }> {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(
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

const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("importing the same file twice publishes one batch", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  const rows = [...absentRegularRows("C00"), ...absentRegularRows("C01")];

  await importRows(db, ctx, rows);
  const before = await count(db, `SELECT COUNT(*)::int AS n FROM payment`);

  const second = await importRows(db, ctx, rows);
  assert.equal(second.alreadyImported, true);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM payment`), before);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM import_batch`), 1);
});

test("a row belonging to another merchant is refused", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await assert.rejects(
    importRows(db, ctx, [{ customer: "C1", date: "2026-07-14", merchant: "someone_else" }]),
    isCode("FORBIDDEN"),
  );
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM import_batch`), 0, "a refused file publishes nothing");
});

test("a malformed file is rejected atomically with the offending row number", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  const { csvOf } = await import("../helpers");
  const good = csvOf(absentRegularRows("C1"), ctx.merchantId);
  const broken = `${good}\n${ctx.merchantId},C2,Synthetic C2,synthetic-sms:+91-5550-9999,true,PAY-BAD,not-a-date,20000,settled`;
  const { importCsv } = await import("../../src/server/importer/import");

  await assert.rejects(importCsv(db, ctx, { content: broken, sourceName: "broken.csv" }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "BAD_REQUEST");
    assert.match(error.message, /Row 5/);
    return true;
  });
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM payment`), 0, "no row from a bad file is published");
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM customer`), 0);
});

test("preview stores one version, recipients split into two groups, and no delivery job", async () => {
  const { db, ctx } = await setup();
  const { campaignId, version, ruleResult } = await previewOf(db, ctx);

  assert.equal(version.version, 1);
  assert.equal(ruleResult.eligible, true);

  const recipients = await listRecipients(db, version.id);
  assert.equal(recipients.length, 20);
  assert.equal(recipients.filter((r) => r.assignment_group === "campaign").length, 10);
  assert.equal(recipients.filter((r) => r.assignment_group === "holdout").length, 10);

  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 0, "preview must never create a delivery job");
  assert.equal((await loadCampaign(db, ctx, campaignId)).status, "REVIEW");
});

test("an over-cap proposal is stored as blocked and cannot be approved", async () => {
  const { db, ctx } = await setup();
  const { campaignId, ruleResult } = await previewOf(db, ctx, 2500);

  assert.equal(ruleResult.eligible, false);
  assert.equal(ruleResult.estimated_cost_minor, 50_000);
  assert.ok(ruleResult.errors.some((error) => error.code === "BUDGET_EXCEEDED"));

  await assert.rejects(
    approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "k1" }),
    isCode("RULE_VIOLATION"),
  );
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 0);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM campaign_approval`), 0);
});

test("revision creates a new immutable version and leaves the old one readable", async () => {
  const { db, ctx } = await setup();
  const { campaignId, version } = await previewOf(db, ctx, 2500);

  const revised = await reviseCampaign(db, ctx, {
    campaignId,
    proposal: proposalOf(),
    budgetCapMinor: 30_000,
  });

  assert.equal(revised.version.version, 2);
  assert.equal((await loadCampaign(db, ctx, campaignId)).current_version, 2);
  const original = await db.one<{ proposal: { offer: { amount_minor: number } } }>(
    `SELECT proposal FROM campaign_version WHERE id = $1`,
    [version.id],
  );
  assert.equal(original!.proposal.offer.amount_minor, 2500, "version 1 must not be mutated");
});

test("approving a stale version is refused", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx, 2500);
  await reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });

  await assert.rejects(
    approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "stale" }),
    isCode("STALE_VERSION"),
  );
});

test("approval creates one job per campaign recipient and none for the holdout", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);

  const result = await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "ok" });
  assert.equal(result.jobsQueued, 10);
  assert.equal(result.status, "QUEUED");

  const holdoutJobs = await count(
    db,
    `SELECT COUNT(*)::int AS n FROM delivery_job j
       JOIN campaign_recipient r ON r.id = j.recipient_id
      WHERE r.assignment_group = 'holdout'`,
  );
  assert.equal(holdoutJobs, 0, "the holdout is the control and must never be contacted");

  const keys = await db.all(`SELECT DISTINCT provider_key FROM delivery_job`);
  assert.equal(keys.length, 10, "each job carries its own stable provider idempotency key");
});

test("replaying the same idempotency key returns the original approval without new jobs", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);

  const first = await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "same" });
  const second = await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "same" });

  assert.equal(second.approvalId, first.approvalId);
  assert.equal(second.replayed, true);
  assert.equal(second.jobsQueued, 10);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 10);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM campaign_approval`), 1);
});

test("concurrent approvals of the same version produce exactly one approval and ten jobs", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: `race-${index}` }),
    ),
  );

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one distinct key wins");
  assert.equal(rejected.length, 4);
  for (const result of rejected) {
    assert.ok(result.status === "rejected" && isCode("DUPLICATE_APPROVAL")(result.reason));
  }
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM campaign_approval`), 1);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 10);
});

test("a second key against an approved version conflicts", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);
  await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "first" });

  await assert.rejects(
    approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "second" }),
    isCode("DUPLICATE_APPROVAL"),
  );
});

test("reusing a key for a different request is an idempotency conflict", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);
  await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "shared" });
  await reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });

  await assert.rejects(
    approveCampaign(db, ctx, { campaignId, version: 2, idempotencyKey: "shared" }),
    isCode("IDEMPOTENCY_CONFLICT"),
  );
});

test("revising after approval expires the approval and cancels queued jobs", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);
  await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "approve" });

  await reviseCampaign(db, ctx, {
    campaignId,
    proposal: proposalOf({ audience_label: "Edited" }),
    budgetCapMinor: 30_000,
  });

  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM campaign_approval WHERE status = 'active'`), 0);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job WHERE status = 'CANCELLED'`), 10);
});

test("consent withdrawn between preview and approval blocks approval and queues nothing", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);

  const customer = await db.one<{ id: string }>(`SELECT id FROM customer LIMIT 1`);
  await db.run(
    `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES ($1, $2, $3, 'false', 'test', $4)`,
    ["con_revoked", ctx.merchantId, customer!.id, new Date().toISOString()],
  );

  await assert.rejects(
    approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "after-revoke" }),
    isCode("RULE_VIOLATION"),
  );
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 0);
});

test("another merchant cannot read or approve this campaign", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx);
  const intruder = await seedMerchant(db, "mch_intruder", "Other merchant");

  await assert.rejects(loadCampaign(db, intruder, campaignId), isCode("FORBIDDEN"));
  await assert.rejects(
    approveCampaign(db, intruder, { campaignId, version: 1, idempotencyKey: "intruder" }),
    isCode("FORBIDDEN"),
  );
});

test("every material transition writes an audit event", async () => {
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db, ctx, 2500);
  await reviseCampaign(db, ctx, { campaignId, proposal: proposalOf(), budgetCapMinor: 30_000 });
  await approveCampaign(db, ctx, { campaignId, version: 2, idempotencyKey: "audited" });

  const actions = (
    await db.all<{ action: string }>(`SELECT action FROM audit_event WHERE campaign_id = $1 ORDER BY seq`, [campaignId])
  ).map((row) => row.action);

  assert.deepEqual(actions, ["campaign.created", "campaign.version_changed", "campaign.approved", "jobs.queued"]);
});

test("the planner never receives contact references or customer identifiers", async () => {
  const { db, ctx } = await setup();
  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
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

test("the template fallback produces a schema-valid proposal without a model", async () => {
  const { db, ctx } = await setup();
  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
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

test("computed comparisons are read-only; choosing a reward requires a fresh approved version", async () => {
  const { buildCampaignDetail } = await import('../../src/server/domain/views');
  const { db, ctx } = await setup();
  const { campaignId } = await previewOf(db,ctx,2500);
  const detail=await buildCampaignDetail(db,ctx,campaignId);
  assert.deepEqual(detail.offer_options.map(o=>o.reward_minor),[750,1125,1500]);
  assert.equal(await count(db,`SELECT COUNT(*)::int AS n FROM delivery_job`),0);
  const selected=detail.offer_options[2]!;
  await reviseCampaign(db,ctx,{campaignId,budgetCapMinor:30000,proposal:proposalOf({copy_format:'separate_reward',offer:{kind:'fixed_reward',amount_minor:selected.reward_minor,valid_days:7,weekday_only:true}})});
  assert.equal(await count(db,`SELECT COUNT(*)::int AS n FROM delivery_job`),0);
  await assert.rejects(approveCampaign(db,ctx,{campaignId,version:1,idempotencyKey:'old-comparison'}),isCode('STALE_VERSION'));
  await approveCampaign(db,ctx,{campaignId,version:2,idempotencyKey:'selected-comparison'});
  const final=await buildCampaignDetail(db,ctx,campaignId);
  assert.equal(final.jobs.length,10);
  assert.match(final.reward_promise,/₹15.00/);
  const { drainQueue } = await import('../../src/server/worker/runner');
  let sent=0;
  await drainQueue(db,{provider:{name:'capture',async send(message){sent++;assert.ok(message.body.endsWith(final.reward_promise));return {outcome:'delivered',providerMessageId:'captured',raw:'ok'};},async getStatus(){return {state:'unavailable',raw:'unknown'};}}});
  assert.equal(sent,10);
});
