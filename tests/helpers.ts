import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MerchantContext } from "../src/server/auth/context";
import { DEMO_MERCHANT_ID } from "../src/server/auth/context";
import { openDatabase, type Db } from "../src/server/db/client";
import type { Proposal } from "../src/server/domain/rules";
import { importCsv } from "../src/server/importer/import";

export const AS_OF = "2026-09-01";

export function tempDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saathi-test-"));
  return openDatabase(path.join(dir, "test.db"));
}

export function seedMerchant(db: Db, id = DEMO_MERCHANT_ID, name = "Test merchant"): MerchantContext {
  db.prepare(
    `INSERT INTO merchant (id, name, timezone, default_cap_minor, created_at)
     VALUES (?, ?, 'Asia/Kolkata', 30000, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(id, name, new Date().toISOString());

  return {
    merchantId: id,
    merchantName: name,
    timezone: "Asia/Kolkata",
    actor: "test-approver",
    isDemoSession: true,
  };
}

export const CSV_HEADER =
  "merchant_id,customer_id,customer_name,contact_ref,consent,payment_id,paid_at,amount_minor,status";

export type CsvRow = {
  customer: string;
  date: string;
  amount?: number;
  status?: "settled" | "refunded" | "duplicate";
  consent?: "true" | "false" | "unknown";
  contact?: string;
  merchant?: string;
};

export function csvOf(rows: CsvRow[], merchantId = DEMO_MERCHANT_ID): string {
  const lines = rows.map((row, index) =>
    [
      row.merchant ?? merchantId,
      row.customer,
      `Synthetic ${row.customer}`,
      row.contact ?? `synthetic-sms:+91-5550-${1000 + index}`,
      row.consent ?? "true",
      `PAY-T${String(index).padStart(4, "0")}`,
      `${row.date}T10:30:00+05:30`,
      String(row.amount ?? 20000),
      row.status ?? "settled",
    ].join(","),
  );
  return [CSV_HEADER, ...lines].join("\n");
}

/** Three settled weekday visits inside the 60-day window but before the 21-day cutoff. */
export function absentRegularRows(customer: string, options: Partial<CsvRow> = {}): CsvRow[] {
  return ["2026-07-14", "2026-07-21", "2026-07-28"].map((date) => ({ customer, date, ...options }));
}

export function importRows(db: Db, ctx: MerchantContext, rows: CsvRow[]) {
  return importCsv(db, ctx, { content: csvOf(rows, ctx.merchantId), sourceName: "test.csv" });
}

export function proposalOf(overrides: Partial<Proposal> = {}): Proposal {
  return {
    audience_label: "Weekday regulars absent for 21 days",
    offer: { kind: "fixed_reward", amount_minor: 1500, valid_days: 7, weekday_only: true },
    timing: { local_start: "11:00", local_end: "16:00" },
    rationale: ["Previously regular customers who stopped returning."],
    copy: {
      headline: "We saved something for your next visit",
      body: "Come by this week and enjoy a reward on your order.",
      cta: "Visit this week",
    },
    exclusions: ["Consent false or unknown"],
    model_estimated_cost_minor: null,
    ...overrides,
  };
}
