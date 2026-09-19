import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackPersona, generateSyntheticCsv, makeRandom } from "../../src/server/demo/synth";
import { parseCsv } from "../../src/server/importer/csv";

test("the same seed reproduces the same dataset; a different seed does not", () => {
  const persona = fallbackPersona(7, 80);
  const a = generateSyntheticCsv({ merchantId: "m", asOf: "2026-09-01", seed: 7, customers: 80, absentShare: 0.3, persona });
  const b = generateSyntheticCsv({ merchantId: "m", asOf: "2026-09-01", seed: 7, customers: 80, absentShare: 0.3, persona });
  const c = generateSyntheticCsv({ merchantId: "m", asOf: "2026-09-01", seed: 8, customers: 80, absentShare: 0.3, persona });
  assert.equal(a.csv, b.csv);
  assert.notEqual(a.csv, c.csv);
  assert.equal(a.customers, 80);
});

test("generated files pass the importer's own validation with unique payment ids", () => {
  const persona = fallbackPersona(11, 120);
  const { csv, rows } = generateSyntheticCsv({ merchantId: "m", asOf: "2026-09-01", seed: 11, customers: 120, absentShare: 0.25, persona });
  const parsed = parseCsv(csv, { maxRows: 20_000 });
  assert.equal(parsed.rows.length, rows);
  assert.equal(parsed.idStrategy, "file_payment_id");
  assert.equal(new Set(parsed.rows.map((r) => r.paymentId)).size, rows);
  assert.ok(parsed.rows.every((r) => r.merchantId === "m"));
  assert.ok(parsed.rows.some((r) => r.status === "refunded" || r.status === "duplicate"), "the mix includes non-visits");
});

test("the generator can produce the 10,000-row workspace limit without adding customers", () => {
  const persona = fallbackPersona(19, 2_000);
  const generated = generateSyntheticCsv({ merchantId: "m", asOf: "2026-09-01", seed: 19, customers: 2_000, rows: 10_000, absentShare: 0.3, persona });
  const parsed = parseCsv(generated.csv, { maxRows: 10_000 });
  assert.equal(generated.rows, 10_000);
  assert.equal(parsed.rows.length, 10_000);
  assert.equal(new Set(parsed.rows.map((row) => row.customerId)).size, 2_000);
});

test("the persona fallback is deterministic and never invents contact details", () => {
  const p1 = fallbackPersona(3, 30);
  const p2 = fallbackPersona(3, 30);
  assert.deepEqual(p1, p2);
  assert.equal(p1.customer_names.length, 30);
  assert.ok(!JSON.stringify(p1).includes("+91"));
  const r = makeRandom(1);
  assert.ok(r() >= 0 && r() < 1);
});
