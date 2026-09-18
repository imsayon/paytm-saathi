import fs from "node:fs";
import path from "node:path";
import { DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME } from "../auth/context";
import type { Db } from "../db/client";

export const FIXTURE_PATH = path.join(process.cwd(), "data", "fixtures", "saathi-demo.csv");
export const FIXTURE_NAME = "saathi-demo.csv";
export const DEMO_AS_OF = "2026-09-01";
export const DEMO_INTENT = "Bring back my weekday regulars. Keep the reward budget under ₹300.";
export const DEMO_BUDGET_CAP_MINOR = 30_000;

export function seedMerchant(db: Db): void {
  db.prepare(
    `INSERT INTO merchant (id, name, timezone, default_cap_minor, created_at)
     VALUES (?, ?, 'Asia/Kolkata', ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
  ).run(DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME, DEMO_BUDGET_CAP_MINOR, new Date().toISOString());
}

export function readFixture(): string {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Demo fixture is missing at ${FIXTURE_PATH}. Run: npx tsx scripts/generate-fixture.ts`);
  }
  return fs.readFileSync(FIXTURE_PATH, "utf8");
}
