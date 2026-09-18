import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { MerchantContext } from "../../src/server/auth/context";
import type { Db } from "../../src/server/db/client";
import { approveCampaign, createCampaignPreview } from "../../src/server/domain/campaign";
import { buildReport } from "../../src/server/domain/measurement";
import { runOutcomeSimulation } from "../../src/server/domain/simulator";
import { mockProvider, resetMockProviderState } from "../../src/server/providers/mock";
import type { DeliveryProvider, SendResult, StatusResult } from "../../src/server/providers/types";
import { drainQueue } from "../../src/server/worker/runner";
import { absentRegularRows, AS_OF, count, importRows, proposalOf, seedMerchant, tempDb } from "../helpers";

async function approvedCampaign(): Promise<{ db: Db; ctx: MerchantContext; campaignId: string; versionId: string }> {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(
    db,
    ctx,
    Array.from({ length: 20 }, (_, index) => absentRegularRows(`C${String(index).padStart(2, "0")}`)).flat(),
  );

  const { campaignId, version } = await createCampaignPreview(db, ctx, {
    intent: "Bring back my weekday regulars.",
    budgetCapMinor: 30_000,
    asOf: AS_OF,
    proposal: proposalOf(),
    aiSource: "template_fallback",
    fallbackReason: null,
  });
  await approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "worker-test" });
  return { db, ctx, campaignId, versionId: version.id };
}

beforeEach(() => resetMockProviderState());

test("a drain delivers every job, recovers the timeout, and records one terminal failure", async () => {
  const { db, versionId } = await approvedCampaign();
  const summary = await drainQueue(db);

  assert.equal(summary.processed, 11, "10 jobs plus one retry of the timed-out job");
  assert.equal(summary.delivered, 9);
  assert.equal(summary.failed, 1);

  const statuses = await db.all<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM delivery_job WHERE version_id = $1 GROUP BY status`,
    [versionId],
  );
  assert.deepEqual(
    Object.fromEntries(statuses.map((row) => [row.status, row.n])),
    { DELIVERED: 9, FAILED: 1 },
  );
});

test("a timeout checks provider status before re-sending and never blindly duplicates", async () => {
  const { db } = await approvedCampaign();
  await drainQueue(db);

  const recovered = await db.all<{ outcome: string }>(
    `SELECT a.outcome FROM delivery_attempt a
       JOIN delivery_job j ON j.id = a.job_id
      WHERE j.scenario_slot = 2 ORDER BY a.attempt_no`,
  );

  assert.deepEqual(
    recovered.map((row) => row.outcome),
    ["timeout", "status_check_not_delivered", "delivered"],
  );
});

test("an unresolvable provider status stops retries and becomes NEEDS_REVIEW", async () => {
  const { db } = await approvedCampaign();

  const alwaysTimeout: DeliveryProvider = {
    name: "always-timeout",
    async send(): Promise<SendResult> {
      return { outcome: "timeout", raw: "{}" };
    },
    async getStatus(): Promise<StatusResult> {
      return { state: "unavailable", raw: "{}" };
    },
  };

  await drainQueue(db, { provider: alwaysTimeout });
  await drainQueue(db, { provider: alwaysTimeout });

  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job WHERE status = 'NEEDS_REVIEW'`), 10);
  const campaign = await db.one<{ status: string }>(`SELECT status FROM campaign`);
  assert.equal(campaign!.status, "NEEDS_REVIEW", "the campaign surfaces the unresolved provider result");

  const third = await drainQueue(db, { provider: alwaysTimeout });
  assert.equal(third.processed, 0, "a job needing review is not retried automatically");
});

test("re-running a drain does not re-send a delivered job", async () => {
  const { db } = await approvedCampaign();
  await drainQueue(db);
  const attemptsBefore = await count(db, `SELECT COUNT(*)::int AS n FROM delivery_attempt`);

  const second = await drainQueue(db);
  assert.equal(second.processed, 0);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_attempt`), attemptsBefore);
});

test("an expired lease is reclaimed after a worker crash", async () => {
  const { db } = await approvedCampaign();
  const job = await db.one<{ id: string }>(`SELECT id FROM delivery_job ORDER BY seq LIMIT 1`);

  // Simulate a worker that claimed the job and then died.
  await db.run(`UPDATE delivery_job SET status = 'PROCESSING', lease_owner = 'dead', lease_expires_at = $1 WHERE id = $2`, [
    new Date(Date.now() - 60_000).toISOString(),
    job!.id,
  ]);

  await drainQueue(db, { workerId: "fresh-worker" });
  const after = await db.one<{ status: string; lease_owner: string | null }>(
    `SELECT status, lease_owner FROM delivery_job WHERE id = $1`,
    [job!.id],
  );
  assert.ok(["DELIVERED", "FAILED"].includes(after!.status), `expected a terminal status, got ${after!.status}`);
  assert.equal(after!.lease_owner, null, "a finished job holds no lease");
});

test("a live lease is not stolen by a second worker", async () => {
  const { db } = await approvedCampaign();
  await db.run(`UPDATE delivery_job SET status = 'PROCESSING', lease_owner = 'worker-a', lease_expires_at = $1`, [
    new Date(Date.now() + 60_000).toISOString(),
  ]);

  const summary = await drainQueue(db, { workerId: "worker-b" });
  assert.equal(summary.processed, 0);
});

test("two workers draining the same queue concurrently never process a job twice", async () => {
  const { db } = await approvedCampaign();

  const [a, b] = await Promise.all([
    drainQueue(db, { workerId: "worker-a" }),
    drainQueue(db, { workerId: "worker-b" }),
  ]);

  assert.equal(a.processed + b.processed, 11, "10 jobs plus the one status-checked retry, split between workers");
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job WHERE status = 'DELIVERED'`), 9);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job WHERE status = 'FAILED'`), 1);
  assert.equal(
    await count(db, `SELECT COUNT(*)::int AS n FROM delivery_attempt WHERE outcome = 'delivered'`),
    9,
    "no delivered job was sent twice",
  );
});

test("consent revoked after approval cancels the job before the provider is called", async () => {
  const { db, ctx } = await approvedCampaign();
  const target = await db.one<{ customer_id: string }>(`SELECT customer_id FROM delivery_job ORDER BY seq LIMIT 1`);
  await db.run(
    `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES ($1, $2, $3, 'false', 'test', $4)`,
    ["con_revoke", ctx.merchantId, target!.customer_id, new Date().toISOString()],
  );

  await drainQueue(db);

  const job = await db.one<{ status: string; cancel_reason: string }>(
    `SELECT status, cancel_reason FROM delivery_job WHERE customer_id = $1`,
    [target!.customer_id],
  );
  assert.equal(job!.status, "CANCELLED");
  assert.equal(job!.cancel_reason, "consent_revoked");

  const attempts = await count(
    db,
    `SELECT COUNT(*)::int AS n FROM delivery_attempt a JOIN delivery_job j ON j.id = a.job_id WHERE j.customer_id = $1`,
    [target!.customer_id],
  );
  assert.equal(attempts, 0, "a cancelled job must never reach the provider");
});

test("the outcome simulation is idempotent and produces the documented 6/10 versus 2/10 result", async () => {
  const { db, ctx, campaignId, versionId } = await approvedCampaign();
  await drainQueue(db);

  const first = await runOutcomeSimulation(db, ctx, campaignId);
  assert.equal(first.campaignReturns, 6);
  assert.equal(first.holdoutReturns, 2);
  assert.equal(first.created, 20);

  const second = await runOutcomeSimulation(db, ctx, campaignId);
  assert.equal(second.created, 0);
  assert.equal(second.alreadySimulated, true);
  assert.equal(second.campaignReturns, 6);
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM outcome`), 20);

  const report = await buildReport(db, campaignId, versionId);
  assert.equal(report.campaign.return_rate, 0.6);
  assert.equal(report.holdout.return_rate, 0.2);
  assert.equal(report.observed_lift_pp, 40);
  assert.equal(report.expected_incremental_returns, 4);
  assert.equal(report.reward_cost_minor, 6 * 1500);
  assert.equal(report.contribution_proxy_minor, 108_000 - 36_000 - 9_000);
  assert.equal(report.delivery_errors, 1);
  assert.equal(report.opt_outs, 1);
});

test("outcomes cannot be simulated before approval", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(
    db,
    ctx,
    Array.from({ length: 20 }, (_, index) => absentRegularRows(`C${String(index).padStart(2, "0")}`)).flat(),
  );
  const { campaignId } = await createCampaignPreview(db, ctx, {
    intent: "x",
    budgetCapMinor: 30_000,
    asOf: AS_OF,
    proposal: proposalOf(),
    aiSource: "template_fallback",
    fallbackReason: null,
  });

  await assert.rejects(runOutcomeSimulation(db, ctx, campaignId), (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as { code?: string }).code === "RULE_VIOLATION"),
  );
  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM outcome`), 0);
});

test("only a customer who actually received the message can return", async () => {
  const { db, ctx, campaignId } = await approvedCampaign();
  await drainQueue(db);
  await runOutcomeSimulation(db, ctx, campaignId);

  const failedCustomer = await db.one<{ customer_id: string }>(`SELECT customer_id FROM delivery_job WHERE status = 'FAILED'`);
  const outcome = await db.one<{ returned: boolean }>(`SELECT returned FROM outcome WHERE customer_id = $1`, [
    failedCustomer!.customer_id,
  ]);
  assert.equal(outcome!.returned, false, "an undelivered customer cannot respond to an offer");
});

test("the mock provider sends nothing outside the recorded attempt log", async () => {
  const { db } = await approvedCampaign();
  await drainQueue(db, { provider: mockProvider });

  assert.equal(await count(db, `SELECT COUNT(*)::int AS n FROM delivery_job`), 10);
  assert.equal(
    await count(db, `SELECT COUNT(*)::int AS n FROM delivery_attempt`),
    12,
    "10 first attempts, plus a status check and a retry for the timed-out job",
  );
});
