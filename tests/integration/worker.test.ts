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
import { absentRegularRows, AS_OF, importRows, proposalOf, seedMerchant, tempDb } from "../helpers";

function approvedCampaign(): { db: Db; ctx: MerchantContext; campaignId: string; versionId: string } {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(
    db,
    ctx,
    Array.from({ length: 20 }, (_, index) => absentRegularRows(`C${String(index).padStart(2, "0")}`)).flat(),
  );

  const { campaignId, version } = createCampaignPreview(db, ctx, {
    intent: "Bring back my weekday regulars.",
    budgetCapMinor: 30_000,
    asOf: AS_OF,
    proposal: proposalOf(),
    aiSource: "template_fallback",
    fallbackReason: null,
  });
  approveCampaign(db, ctx, { campaignId, version: 1, idempotencyKey: "worker-test" });
  return { db, ctx, campaignId, versionId: version.id };
}

beforeEach(() => resetMockProviderState());

test("a drain delivers every job, recovers the timeout, and records one terminal failure", async () => {
  const { db, versionId } = approvedCampaign();
  const summary = await drainQueue(db);

  assert.equal(summary.processed, 11, "10 jobs plus one retry of the timed-out job");
  assert.equal(summary.delivered, 9);
  assert.equal(summary.failed, 1);

  const statuses = db
    .prepare(`SELECT status, COUNT(*) AS n FROM delivery_job WHERE version_id = ? GROUP BY status`)
    .all(versionId) as { status: string; n: number }[];
  assert.deepEqual(
    Object.fromEntries(statuses.map((row) => [row.status, row.n])),
    { DELIVERED: 9, FAILED: 1 },
  );
});

test("a timeout checks provider status before re-sending and never blindly duplicates", async () => {
  const { db } = approvedCampaign();
  await drainQueue(db);

  const recovered = db
    .prepare(
      `SELECT a.outcome FROM delivery_attempt a
         JOIN delivery_job j ON j.id = a.job_id
        WHERE j.scenario_slot = 2 ORDER BY a.attempt_no`,
    )
    .all() as { outcome: string }[];

  assert.deepEqual(
    recovered.map((row) => row.outcome),
    ["timeout", "status_check_not_delivered", "delivered"],
  );
});

test("an unresolvable provider status stops retries and becomes NEEDS_REVIEW", async () => {
  const { db } = approvedCampaign();

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

  const needsReview = db.prepare(`SELECT COUNT(*) AS n FROM delivery_job WHERE status = 'NEEDS_REVIEW'`).get() as {
    n: number;
  };
  assert.equal(needsReview.n, 10);

  const third = await drainQueue(db, { provider: alwaysTimeout });
  assert.equal(third.processed, 0, "a job needing review is not retried automatically");
});

test("re-running a drain does not re-send a delivered job", async () => {
  const { db } = approvedCampaign();
  await drainQueue(db);
  const attemptsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_attempt`).get() as { n: number }).n;

  const second = await drainQueue(db);
  assert.equal(second.processed, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM delivery_attempt`).get() as { n: number }).n, attemptsBefore);
});

test("an expired lease is reclaimed after a worker crash", async () => {
  const { db } = approvedCampaign();
  const job = db.prepare(`SELECT id FROM delivery_job LIMIT 1`).get() as { id: string };

  // Simulate a worker that claimed the job and then died.
  db.prepare(`UPDATE delivery_job SET status = 'PROCESSING', lease_owner = 'dead', lease_expires_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 60_000).toISOString(),
    job.id,
  );

  await drainQueue(db, { workerId: "fresh-worker" });
  const after = db.prepare(`SELECT status FROM delivery_job WHERE id = ?`).get(job.id) as { status: string };
  assert.ok(["DELIVERED", "FAILED"].includes(after.status), `expected a terminal status, got ${after.status}`);
});

test("a live lease is not stolen by a second worker", async () => {
  const { db } = approvedCampaign();
  db.prepare(`UPDATE delivery_job SET status = 'PROCESSING', lease_owner = 'worker-a', lease_expires_at = ?`).run(
    new Date(Date.now() + 60_000).toISOString(),
  );

  const summary = await drainQueue(db, { workerId: "worker-b" });
  assert.equal(summary.processed, 0);
});

test("consent revoked after approval cancels the job before the provider is called", async () => {
  const { db, ctx } = approvedCampaign();
  const target = db.prepare(`SELECT customer_id FROM delivery_job ORDER BY rowid LIMIT 1`).get() as {
    customer_id: string;
  };
  db.prepare(
    `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES (?, ?, ?, 'false', 'test', ?)`,
  ).run("con_revoke", ctx.merchantId, target.customer_id, new Date().toISOString());

  await drainQueue(db);

  const job = db.prepare(`SELECT status, cancel_reason FROM delivery_job WHERE customer_id = ?`).get(
    target.customer_id,
  ) as { status: string; cancel_reason: string };
  assert.equal(job.status, "CANCELLED");
  assert.equal(job.cancel_reason, "consent_revoked");

  const attempts = db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_attempt a JOIN delivery_job j ON j.id = a.job_id WHERE j.customer_id = ?`,
    )
    .get(target.customer_id) as { n: number };
  assert.equal(attempts.n, 0, "a cancelled job must never reach the provider");
});

test("the outcome simulation is idempotent and produces the documented 6/10 versus 2/10 result", async () => {
  const { db, ctx, campaignId, versionId } = approvedCampaign();
  await drainQueue(db);

  const first = runOutcomeSimulation(db, ctx, campaignId);
  assert.equal(first.campaignReturns, 6);
  assert.equal(first.holdoutReturns, 2);
  assert.equal(first.created, 20);

  const second = runOutcomeSimulation(db, ctx, campaignId);
  assert.equal(second.created, 0);
  assert.equal(second.alreadySimulated, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM outcome`).get() as { n: number }).n, 20);

  const report = buildReport(db, campaignId, versionId);
  assert.equal(report.campaign.return_rate, 0.6);
  assert.equal(report.holdout.return_rate, 0.2);
  assert.equal(report.observed_lift_pp, 40);
  assert.equal(report.expected_incremental_returns, 4);
  assert.equal(report.reward_cost_minor, 6 * 1500);
  assert.equal(report.delivery_errors, 1);
});

test("only a customer who actually received the message can return", async () => {
  const { db, ctx, campaignId } = approvedCampaign();
  await drainQueue(db);
  runOutcomeSimulation(db, ctx, campaignId);

  const failedCustomer = db.prepare(`SELECT customer_id FROM delivery_job WHERE status = 'FAILED'`).get() as {
    customer_id: string;
  };
  const outcome = db.prepare(`SELECT returned FROM outcome WHERE customer_id = ?`).get(failedCustomer.customer_id) as {
    returned: number;
  };
  assert.equal(outcome.returned, 0, "an undelivered customer cannot respond to an offer");
});

test("the mock provider sends nothing outside the recorded attempt log", async () => {
  const { db } = approvedCampaign();
  await drainQueue(db, { provider: mockProvider });

  const attempts = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_attempt`).get() as { n: number }).n;
  const jobs = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_job`).get() as { n: number }).n;
  assert.equal(jobs, 10);
  assert.equal(attempts, 12, "10 first attempts, plus a status check and a retry for the timed-out job");
});
