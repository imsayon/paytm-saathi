import fs from "node:fs";
import path from "node:path";
import { DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME } from "../auth/context";
import type { Db } from "../db/client";

export const FIXTURE_PATH = path.join(process.cwd(), "data", "fixtures", "saathi-demo.csv");
export const FIXTURE_NAME = "saathi-demo.csv";
export const DEMO_AS_OF = "2026-09-01";
export const DEMO_INTENT = "Bring back my weekday regulars. Keep the reward budget under ₹300.";
export const DEMO_BUDGET_CAP_MINOR = 30_000;

export async function seedMerchant(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO merchant (id, name, timezone, default_cap_minor, created_at)
     VALUES ($1, $2, 'Asia/Kolkata', $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
    [DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME, DEMO_BUDGET_CAP_MINOR, new Date().toISOString()],
  );
}

export function readFixture(): string {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Demo fixture is missing at ${FIXTURE_PATH}. Run: pnpm fixture:generate`);
  }
  return fs.readFileSync(FIXTURE_PATH, "utf8");
}

/**
 * Demo control: removes every row that belongs to the demo merchant so the
 * rehearsed sequence can be run again from "Load demo CSV". The merchant row
 * itself stays. Order follows the foreign keys.
 */
export async function resetDemoData(db: Db, merchantId: string): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const deleted: Record<string, number> = {};
    deleted.outcome = await tx.run(`DELETE FROM outcome WHERE merchant_id = $1`, [merchantId]);
    deleted.delivery_attempt = await tx.run(
      `DELETE FROM delivery_attempt WHERE job_id IN (SELECT id FROM delivery_job WHERE merchant_id = $1)`,
      [merchantId],
    );
    deleted.delivery_job = await tx.run(`DELETE FROM delivery_job WHERE merchant_id = $1`, [merchantId]);
    deleted.campaign_approval = await tx.run(`DELETE FROM campaign_approval WHERE merchant_id = $1`, [merchantId]);
    deleted.campaign_exclusion = await tx.run(`DELETE FROM campaign_exclusion WHERE merchant_id = $1`, [merchantId]);
    deleted.campaign_recipient = await tx.run(`DELETE FROM campaign_recipient WHERE merchant_id = $1`, [merchantId]);
    deleted.campaign_version = await tx.run(`DELETE FROM campaign_version WHERE merchant_id = $1`, [merchantId]);
    deleted.campaign = await tx.run(`DELETE FROM campaign WHERE merchant_id = $1`, [merchantId]);
    deleted.audit_event = await tx.run(`DELETE FROM audit_event WHERE merchant_id = $1`, [merchantId]);
    deleted.payment = await tx.run(`DELETE FROM payment WHERE merchant_id = $1`, [merchantId]);
    deleted.consent = await tx.run(`DELETE FROM consent WHERE merchant_id = $1`, [merchantId]);
    deleted.customer = await tx.run(`DELETE FROM customer WHERE merchant_id = $1`, [merchantId]);
    deleted.import_batch = await tx.run(`DELETE FROM import_batch WHERE merchant_id = $1`, [merchantId]);
    return deleted;
  });
}
