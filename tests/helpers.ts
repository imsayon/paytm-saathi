import crypto from "node:crypto";
import { after, afterEach } from "node:test";
import type { Pool } from "pg";
import type { MerchantContext } from "../src/server/auth/context";
import { DEMO_MERCHANT_ID } from "../src/server/auth/context";
import { loadEnvFiles } from "../src/server/env";
import { createPool, Db, quoteIdent } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import type { Proposal } from "../src/server/domain/rules";
import { importCsv } from "../src/server/importer/import";

loadEnvFiles();

export const AS_OF = "2026-09-01";

/**
 * Tests run against a real Postgres: TEST_DATABASE_URL (the Neon `test` branch
 * or a local server), else the direct application URL. Every tempDb() call gets
 * its own schema with the migrations applied, dropped when the file finishes,
 * so tests are isolated and never touch demo data in `public`.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "No test database configured. Set TEST_DATABASE_URL (recommended: the Neon `test` branch or a local Postgres).",
    );
  }
  return url;
}

type TestDb = { db: Db; schema: string; pool: Pool };
const created: TestDb[] = [];
let adminPool: Pool | null = null;

function admin(): Pool {
  if (!adminPool) adminPool = createPool(testDatabaseUrl(), { max: 2 });
  return adminPool;
}

export async function tempDb(): Promise<Db> {
  const schema = `saathi_test_${crypto.randomBytes(6).toString("hex")}`;
  await admin().query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  const pool = createPool(testDatabaseUrl(), { schema, max: 3 });
  const db = new Db(pool);
  await runMigrations(db);
  created.push({ db, schema, pool });
  return db;
}

async function dropCreated(): Promise<void> {
  for (const entry of created.splice(0)) {
    await entry.pool.end();
    await admin().query(`DROP SCHEMA IF EXISTS ${quoteIdent(entry.schema)} CASCADE`);
  }
}

// Schemas and their connections are released after every test, so a file with
// many tests never holds more than a handful of connections at once.
afterEach(dropCreated);

after(async () => {
  await dropCreated();
  await adminPool?.end();
  adminPool = null;
});

export async function seedMerchant(db: Db, id = DEMO_MERCHANT_ID, name = "Test merchant"): Promise<MerchantContext> {
  await db.run(
    `INSERT INTO merchant (id, name, timezone, default_cap_minor, created_at)
     VALUES ($1, $2, 'Asia/Kolkata', 30000, $3) ON CONFLICT (id) DO NOTHING`,
    [id, name, new Date().toISOString()],
  );

  return {
    merchantId: id,
    merchantName: name,
    timezone: "Asia/Kolkata",
    actor: "test-approver",
    isDemoSession: true,
    user: null,
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

export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const row = await db.one<{ n: number }>(sql, params);
  return row?.n ?? 0;
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
