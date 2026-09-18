import { config } from "../config";
import type { Db } from "../db/client";
import { AppError } from "../errors";

export const DEMO_MERCHANT_ID = "mch_demo_bengaluru";
export const DEMO_MERCHANT_NAME = "Chai Point Koramangala (synthetic demo merchant)";
export const DEMO_APPROVER = "demo-merchant-owner";

export type MerchantContext = {
  merchantId: string;
  merchantName: string;
  timezone: string;
  actor: string;
  isDemoSession: boolean;
};

/**
 * Development-only merchant session. There is no real authentication yet: the
 * demo seeds one merchant and every request is scoped to it. Refusing to resolve
 * a context outside demo mode is what keeps this from silently becoming prod auth.
 */
export async function requireMerchantContext(db: Db): Promise<MerchantContext> {
  if (!config.demoMode) {
    throw new AppError(
      "UNAUTHENTICATED",
      "No merchant session. Real authentication is not implemented; this build only supports the labelled demo session.",
    );
  }
  const row = await db.one<{ id: string; name: string; timezone: string }>(
    `SELECT id, name, timezone FROM merchant WHERE id = $1`,
    [DEMO_MERCHANT_ID],
  );

  if (!row) {
    throw new AppError("UNAVAILABLE", "Demo merchant is not seeded. Run: npm run db:seed");
  }

  return {
    merchantId: row.id,
    merchantName: row.name,
    timezone: row.timezone,
    actor: DEMO_APPROVER,
    isDemoSession: true,
  };
}

export function assertOwnedByMerchant(ownerMerchantId: string, ctx: MerchantContext): void {
  if (ownerMerchantId !== ctx.merchantId) {
    throw new AppError("FORBIDDEN", "This resource belongs to a different merchant.");
  }
}
