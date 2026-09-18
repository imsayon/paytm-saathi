import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSignal } from "../../src/server/domain/signal";
import { absentRegularRows, AS_OF, importRows, seedMerchant, tempDb } from "../helpers";

test("an absent regular needs 3 settled visits across 2+ dates and no visit in the last 21 days", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, absentRegularRows("C1"));

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
  assert.equal(signal.eligibleCount, 1);
});

test("three visits on one date is not a regular: distinct dates must be at least 2", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-14" },
  ]);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.regularCustomers, 0);
  assert.equal(signal.absentRegulars, 0);
});

test("two settled visits is not a regular", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
  ]);

  assert.equal((await computeSignal(db, ctx.merchantId, AS_OF)).regularCustomers, 0);
});

test("refunded and duplicate payments do not count as visits", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-07-28", status: "refunded" },
    { customer: "C1", date: "2026-07-30", status: "duplicate" },
  ]);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.regularCustomers, 0, "refunded and duplicate rows must not create a third visit");
});

test("a recent refunded payment does not end an absence", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [...absentRegularRows("C1"), { customer: "C1", date: "2026-08-28", status: "refunded" }]);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
});

test("the 21-day inactivity boundary is inclusive: a visit exactly 21 days back is still absent", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-08-11" },
  ]);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);

  const db2 = await tempDb();
  const ctx2 = await seedMerchant(db2);
  await importRows(db2, ctx2, [
    { customer: "C1", date: "2026-07-14" },
    { customer: "C1", date: "2026-07-21" },
    { customer: "C1", date: "2026-08-12" },
  ]);
  assert.equal(
    (await computeSignal(db2, ctx2.merchantId, AS_OF)).absentRegulars,
    0,
    "one day inside the window is not absent",
  );
});

test("visits older than the 60-day lookback do not make a regular", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    { customer: "C1", date: "2026-06-01" },
    { customer: "C1", date: "2026-06-08" },
    { customer: "C1", date: "2026-07-14" },
  ]);

  assert.equal((await computeSignal(db, ctx.merchantId, AS_OF)).regularCustomers, 0);
});

test("consent false or unknown is excluded with a reason, and consent true is eligible", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, [
    ...absentRegularRows("YES", { consent: "true" }),
    ...absentRegularRows("NO", { consent: "false" }),
    ...absentRegularRows("MAYBE", { consent: "unknown" }),
  ]);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 3);
  assert.equal(signal.eligibleCount, 1);
  assert.equal(signal.excluded.consent_false, 1);
  assert.equal(signal.excluded.consent_unknown, 1);
  assert.deepEqual(
    signal.absent.filter((c) => !c.eligible).map((c) => c.exclusionReason).sort(),
    ["consent_false", "consent_unknown"],
    "each excluded customer carries a visible reason",
  );
});

test("a missing contact reference excludes an otherwise eligible customer", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, absentRegularRows("C1", { contact: "" }));

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 1);
  assert.equal(signal.eligibleCount, 0);
  assert.equal(signal.excluded.no_contact_ref, 1);
});

test("the latest consent record wins", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  await importRows(db, ctx, absentRegularRows("C1", { consent: "true" }));
  const customer = await db.one<{ id: string }>(`SELECT id FROM customer LIMIT 1`);
  await db.run(
    `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES ('con_later', $1, $2, 'false', 'test', $3)`,
    [ctx.merchantId, customer!.id, new Date().toISOString()],
  );

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.eligibleCount, 0);
  assert.equal(signal.excluded.consent_false, 1);
});

test("the eligible cohort is capped and the ordering is stable across runs", async () => {
  const db = await tempDb();
  const ctx = await seedMerchant(db);
  const rows = Array.from({ length: 25 }, (_, index) =>
    absentRegularRows(`C${String(index).padStart(2, "0")}`),
  ).flat();
  await importRows(db, ctx, rows);

  const first = await computeSignal(db, ctx.merchantId, AS_OF);
  const second = await computeSignal(db, ctx.merchantId, AS_OF);

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
  const db = await tempDb();
  const ctx = await seedMerchant(db);

  const result = await importCsv(db, ctx, { content: readFixture(), sourceName: "saathi-demo.csv" });
  assert.equal(result.rowCount, 243);
  assert.equal(result.customerCount, 78);

  const signal = await computeSignal(db, ctx.merchantId, AS_OF);
  assert.equal(signal.absentRegulars, 24);
  assert.equal(signal.eligibleCount, 20);
  assert.equal(signal.excluded.consent_false, 2);
  assert.equal(signal.excluded.consent_unknown, 2);
});
