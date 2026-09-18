import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSignal } from "../../src/server/domain/signal";
import { absentRegularRows, AS_OF, importRows, seedMerchant, tempDb } from "../helpers";

test("an absent regular needs 3 settled visits across 2+ dates and no visit in the last 21 days", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, absentRegularRows("C1"));

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
  assert.equal(signal.eligibleCount, 1);
});

test("three visits on one date is not a regular: distinct dates must be at least 2", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-14" },
  ]);

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.regularCustomers, 0);
  assert.equal(signal.absentRegulars, 0);
});

test("two settled visits is not a regular", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
  ]);

  assert.equal(computeSignal(db, ctx.merchantId, AS_OF).regularCustomers, 0);
});

test("refunded and duplicate payments do not count as visits", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-07-28", status: "refunded" },
    { customer: "C1", date: "2026-07-30", status: "duplicate" },
  ]);

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.regularCustomers, 0, "refunded and duplicate rows must not create a third visit");
});

test("a recent refunded payment does not end an absence", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [...absentRegularRows("C1"), { customer: "C1", date: "2026-08-28", status: "refunded" }]);

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
});

test("the 21-day inactivity boundary is inclusive: a visit exactly 21 days back is still absent", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-08-11" },
  ]);

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);

  const db2 = tempDb();
  const ctx2 = seedMerchant(db2);
  importRows(db2, ctx2, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-08-12" },
  ]);
  assert.equal(computeSignal(db2, ctx2.merchantId, AS_OF).absentRegulars, 0, "one day inside the window is not absent");
});

test("visits older than the 60-day lookback do not make a regular", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    { customer: "C1", date: "2026-06-01" },
    { customer: "C1", date: "2026-06-08" },
    { customer: "C1", date: "2026-07-14" },
  ]);

  assert.equal(computeSignal(db, ctx.merchantId, AS_OF).regularCustomers, 0);
});

test("consent false or unknown is excluded with a reason, and consent true is eligible", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, [
    ...absentRegularRows("YES", { consent: "true" }),
    ...absentRegularRows("NO", { consent: "false" }),
    ...absentRegularRows("MAYBE", { consent: "unknown" }),
  ]);

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 3);
  assert.equal(signal.eligibleCount, 1);
  assert.equal(signal.excluded.consent_false, 1);
  assert.equal(signal.excluded.consent_unknown, 1);
});

test("a missing contact reference excludes an otherwise eligible customer", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  importRows(db, ctx, absentRegularRows("C1", { contact: "" }));

  const signal = computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
  assert.equal(signal.eligibleCount, 0);
  assert.equal(signal.excluded.no_contact_ref, 1);
});

test("the eligible cohort is capped and the ordering is stable across runs", () => {
  const db = tempDb();
  const ctx = seedMerchant(db);
  const rows = Array.from({ length: 25 }, (_, index) =>
    absentRegularRows(`C${String(index).padStart(2, "0")}`),
  ).flat();
  importRows(db, ctx, rows);

  const first = computeSignal(db, ctx.merchantId, AS_OF);
  const second = computeSignal(db, ctx.merchantId, AS_OF);

  assert.equal(first.absentRegulars, 25);
  assert.equal(first.eligibleCount, 20);
  assert.equal(first.excluded.over_cohort_cap, 5);
  assert.deepEqual(
    first.eligible.map((customer) => customer.externalId),
    second.eligible.map((customer) => customer.externalId),
  );
  assert.equal(first.cohortHash, second.cohortHash);
});

test("the demo fixture produces the documented 24 absent regulars and 20 eligible", async () => {
  const { readFixture } = await import("../../src/server/demo/fixture");
  const { importCsv } = await import("../../src/server/importer/import");
  const db = tempDb();
  const ctx = seedMerchant(db);

  importCsv(db, ctx, { content: readFixture(), sourceName: "saathi-demo.csv" });
  const signal = computeSignal(db, ctx.merchantId, AS_OF);

  assert.equal(signal.absentRegulars, 24);
  assert.equal(signal.eligibleCount, 20);
  assert.equal(signal.excluded.consent_false, 2);
  assert.equal(signal.excluded.consent_unknown, 2);
});
