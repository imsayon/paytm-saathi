import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../../src/server/importer/csv";
import { AppError } from "../../src/server/errors";
import { CSV_HEADER } from "../helpers";

const OPTIONS = { maxRows: 1000 };

function csv(...rows: string[]): string {
  return [CSV_HEADER, ...rows].join("\n");
}

test("a well-formed row parses into typed values", () => {
  const result = parseCsv(
    csv("m1,c1,Synthetic C1,synthetic-sms:+91-5550-1000,true,PAY-1,2026-07-14T10:30:00+05:30,20000,settled"),
    OPTIONS,
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.idStrategy, "file_payment_id");
  assert.equal(result.rows[0]!.amountMinor, 20000);
  assert.equal(result.rows[0]!.status, "settled");
  assert.equal(result.rows[0]!.consent, "true");
});

test("missing required columns are reported by name", () => {
  assert.throws(
    () => parseCsv("merchant_id,customer_id\nm1,c1", OPTIONS),
    (error: AppError) => error.code === "BAD_REQUEST" && error.message.includes("paid_at"),
  );
});

test("a malformed amount, date, status or consent names the offending row", () => {
  const cases = [
    ["m1,c1,N,ref,true,PAY-1,2026-07-14T10:30:00+05:30,12.50,settled", "amount_minor"],
    ["m1,c1,N,ref,true,PAY-1,not-a-date,20000,settled", "paid_at"],
    ["m1,c1,N,ref,true,PAY-1,2026-07-14T10:30:00+05:30,20000,pending", "status"],
    ["m1,c1,N,ref,maybe,PAY-1,2026-07-14T10:30:00+05:30,20000,settled", "consent"],
  ] as const;

  for (const [row, field] of cases) {
    assert.throws(
      () => parseCsv(csv(row), OPTIONS),
      (error: AppError) => error.message.includes("Row 2") && error.message.includes(field),
      `expected row 2 to fail on ${field}`,
    );
  }
});

test("a duplicate payment_id inside one file is rejected", () => {
  assert.throws(
    () =>
      parseCsv(
        csv(
          "m1,c1,N,ref,true,PAY-1,2026-07-14T10:30:00+05:30,20000,settled",
          "m1,c1,N,ref,true,PAY-1,2026-07-15T10:30:00+05:30,20000,settled",
        ),
        OPTIONS,
      ),
    (error: AppError) => error.message.includes("duplicate payment_id"),
  );
});

test("a file without payment_id derives ids and is marked as the unsafe fallback strategy", () => {
  const header = "merchant_id,customer_id,contact_ref,consent,paid_at,amount_minor,status";
  const result = parseCsv(
    [header, "m1,c1,ref,true,2026-07-14T10:30:00+05:30,20000,settled"].join("\n"),
    OPTIONS,
  );

  assert.equal(result.idStrategy, "derived_id");
  assert.match(result.rows[0]!.paymentId, /^derived_/);
});

test("spreadsheet formula content is neutralised rather than stored as written", () => {
  const result = parseCsv(
    csv('m1,c1,"=SUM(A1:A9)",ref,true,PAY-1,2026-07-14T10:30:00+05:30,20000,settled'),
    OPTIONS,
  );
  assert.equal(result.rows[0]!.customerName, "'=SUM(A1:A9)");
});

test("quoted fields containing commas and escaped quotes parse correctly", () => {
  const result = parseCsv(
    csv('m1,c1,"Kumar, A. ""KK""",ref,true,PAY-1,2026-07-14T10:30:00+05:30,20000,settled'),
    OPTIONS,
  );
  assert.equal(result.rows[0]!.customerName, 'Kumar, A. "KK"');
});

test("the row limit is enforced", () => {
  const rows = Array.from(
    { length: 3 },
    (_, index) => `m1,c1,N,ref,true,PAY-${index},2026-07-14T10:30:00+05:30,20000,settled`,
  );
  assert.throws(() => parseCsv(csv(...rows), { maxRows: 2 }), (error: AppError) => error.code === "BAD_REQUEST");
});

test("the same content always produces the same checksum", () => {
  const content = csv("m1,c1,N,ref,true,PAY-1,2026-07-14T10:30:00+05:30,20000,settled");
  assert.equal(parseCsv(content, OPTIONS).checksum, parseCsv(content, OPTIONS).checksum);
});
