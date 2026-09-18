/**
 * Regenerates data/fixtures/saathi-demo.csv.
 *
 * The CSV is committed and treated as frozen demo data; this script exists so the
 * fixture is reproducible and reviewable, not so it can be regenerated at runtime.
 *
 * Run: npx tsx scripts/generate-fixture.ts
 */
import fs from "node:fs";
import path from "node:path";

const AS_OF = "2026-09-01";
const MERCHANT_ID = "mch_demo_bengaluru";
const OUTPUT = path.join(process.cwd(), "data", "fixtures", "saathi-demo.csv");

const INACTIVITY_DAYS = 21;
const LOOKBACK_DAYS = 60;

type Row = {
  merchant_id: string;
  customer_id: string;
  customer_name: string;
  contact_ref: string;
  consent: "true" | "false" | "unknown";
  payment_id: string;
  paid_at: string;
  amount_minor: number;
  status: "settled" | "refunded" | "duplicate";
};

/** Deterministic LCG so amounts and date choices are stable across regenerations. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function isWeekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function weekdaysBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    if (isWeekday(cursor)) dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function timestamp(date: string, hour: number): string {
  return `${date}T${String(hour).padStart(2, "0")}:30:00+05:30`;
}

const random = makeRandom(20260919);
const rows: Row[] = [];
let paymentSeq = 0;

function amount(): number {
  return 12_000 + Math.floor(random() * 23_000);
}

function pushPayment(
  customer: { id: string; name: string; contact: string; consent: Row["consent"] },
  date: string,
  status: Row["status"] = "settled",
  hour = 10,
): void {
  paymentSeq += 1;
  rows.push({
    merchant_id: MERCHANT_ID,
    customer_id: customer.id,
    customer_name: customer.name,
    contact_ref: customer.contact,
    consent: customer.consent,
    payment_id: `PAY-${String(paymentSeq).padStart(5, "0")}`,
    paid_at: timestamp(date, hour),
    amount_minor: amount(),
    status,
  });
}

function pick<T>(items: T[], count: number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  }
  return chosen.sort();
}

// Absent regulars: every visit sits inside the 60-day window but before the
// 21-day inactivity cutoff.
const absentWindow = weekdaysBetween(addDays(AS_OF, -LOOKBACK_DAYS + 2), addDays(AS_OF, -INACTIVITY_DAYS - 4));
// Active regulars need at least one visit inside the inactivity window.
const recentWindow = weekdaysBetween(addDays(AS_OF, -INACTIVITY_DAYS + 2), AS_OF);

for (let i = 1; i <= 24; i += 1) {
  const id = `CUST-A${String(i).padStart(2, "0")}`;
  const consent: Row["consent"] = i <= 20 ? "true" : i <= 22 ? "false" : "unknown";
  const customer = {
    id,
    name: `Synthetic Customer A${String(i).padStart(2, "0")}`,
    contact: `synthetic-sms:+91-5550-${String(1000 + i)}`,
    consent,
  };

  for (const date of pick(absentWindow, 3 + (i % 2))) pushPayment(customer, date, "settled", 9 + (i % 5));

  // Refunded and duplicate rows inside the inactivity window: these must not
  // count as visits, so these customers stay "absent".
  if (i === 1 || i === 2) pushPayment(customer, addDays(AS_OF, -9), "refunded", 12);
  if (i === 3) pushPayment(customer, addDays(AS_OF, -6), "duplicate", 13);
}

for (let i = 1; i <= 32; i += 1) {
  const id = `CUST-B${String(i).padStart(2, "0")}`;
  const customer = {
    id,
    name: `Synthetic Customer B${String(i).padStart(2, "0")}`,
    contact: `synthetic-sms:+91-5551-${String(1000 + i)}`,
    consent: (i % 11 === 0 ? "unknown" : "true") as Row["consent"],
  };

  for (const date of pick(absentWindow, 2)) pushPayment(customer, date, "settled", 9 + (i % 6));
  for (const date of pick(recentWindow, 1 + (i % 3))) pushPayment(customer, date, "settled", 9 + (i % 7));
  if (i === 4) pushPayment(customer, addDays(AS_OF, -12), "refunded", 15);
}

for (let i = 1; i <= 22; i += 1) {
  const id = `CUST-C${String(i).padStart(2, "0")}`;
  const customer = {
    id,
    name: `Synthetic Customer C${String(i).padStart(2, "0")}`,
    contact: `synthetic-sms:+91-5552-${String(1000 + i)}`,
    consent: (i % 7 === 0 ? "false" : "true") as Row["consent"],
  };

  if (i === 21) {
    // Three visits on a single date: enough payments to look regular, but only
    // one distinct date, so the >= 2 distinct dates rule must reject it.
    const date = absentWindow[4]!;
    pushPayment(customer, date, "settled", 9);
    pushPayment(customer, date, "settled", 13);
    pushPayment(customer, date, "settled", 18);
  } else if (i === 22) {
    pushPayment(customer, absentWindow[2]!, "settled", 11);
    pushPayment(customer, absentWindow[9]!, "settled", 16);
    pushPayment(customer, addDays(AS_OF, -70), "settled", 11);
  } else if (i % 2 === 0) {
    for (const date of pick(recentWindow, 1)) pushPayment(customer, date, "settled", 10 + (i % 5));
  } else {
    for (const date of pick(absentWindow, 1)) pushPayment(customer, date, "settled", 10 + (i % 5));
  }
}

rows.sort((a, b) => a.paid_at.localeCompare(b.paid_at) || a.payment_id.localeCompare(b.payment_id));

const header = [
  "merchant_id",
  "customer_id",
  "customer_name",
  "contact_ref",
  "consent",
  "payment_id",
  "paid_at",
  "amount_minor",
  "status",
];

const csv = [
  header.join(","),
  ...rows.map((row) =>
    [
      row.merchant_id,
      row.customer_id,
      row.customer_name,
      row.contact_ref,
      row.consent,
      row.payment_id,
      row.paid_at,
      String(row.amount_minor),
      row.status,
    ].join(","),
  ),
].join("\n");

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${csv}\n`, "utf8");

const customers = new Set(rows.map((row) => row.customer_id));
console.log(
  JSON.stringify(
    {
      output: path.relative(process.cwd(), OUTPUT),
      as_of: AS_OF,
      rows: rows.length,
      customers: customers.size,
      settled: rows.filter((row) => row.status === "settled").length,
      refunded: rows.filter((row) => row.status === "refunded").length,
      duplicate: rows.filter((row) => row.status === "duplicate").length,
    },
    null,
    2,
  ),
);
