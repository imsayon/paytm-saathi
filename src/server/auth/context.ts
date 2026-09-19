import crypto from "node:crypto";
import { config } from "../config";
import type { Db } from "../db/client";
import { AppError } from "../errors";
import { getSessionUser, supabaseConfigured } from "./supabase";

export const DEMO_MERCHANT_ID = "mch_demo_bengaluru";
export const DEMO_MERCHANT_NAME = "Chai Point Koramangala (synthetic demo merchant)";
export const DEMO_APPROVER = "demo-merchant-owner";

export type MerchantContext = {
  merchantId: string;
  merchantName: string;
  timezone: string;
  actor: string;
  isDemoSession: boolean;
  /** Present when a real person is signed in through Supabase. */
  user: { id: string; email: string | null; phone: string | null } | null;
};

type MerchantRow = { id: string; name: string; timezone: string };

function merchantIdForUser(userId: string): string {
  return `mch_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 20)}`;
}

/**
 * Who is acting, and which merchant's data they may touch.
 *
 * 1. A Supabase session wins: the merchant is looked up by the user's id and
 *    created on first sign-in (a private, empty workspace named after the
 *    email or phone). Every query downstream is scoped to that merchant id,
 *    so one merchant can never read or approve another's campaign.
 * 2. With no session and demo mode on, the seeded demo merchant is used and
 *    labelled as such.
 * 3. Otherwise the request is unauthenticated.
 */
export async function requireMerchantContext(db: Db): Promise<MerchantContext> {
  const user = await getSessionUser();
  if (user) {
    const id = merchantIdForUser(user.id);
    const existing = await db.one<MerchantRow>(`SELECT id, name, timezone FROM merchant WHERE auth_user_id = $1`, [user.id]);
    const row =
      existing ??
      (await db.one<MerchantRow>(
        `INSERT INTO merchant (id, name, timezone, default_cap_minor, created_at, auth_user_id, email, phone, created_via)
         VALUES ($1, $2, 'Asia/Kolkata', 30000, $3, $4, $5, $6, 'supabase')
         ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
         DO UPDATE SET email = excluded.email, phone = excluded.phone
         RETURNING id, name, timezone`,
        [id, `${user.email ?? user.phone ?? "Merchant"}'s shop`, new Date().toISOString(), user.id, user.email, user.phone],
      ))!;
    return {
      merchantId: row.id,
      merchantName: row.name,
      timezone: row.timezone,
      actor: user.email ?? user.phone ?? user.id,
      isDemoSession: false,
      user,
    };
  }

  if (!config.demoMode) {
    throw new AppError(
      "UNAUTHENTICATED",
      supabaseConfigured() ? "Sign in to continue." : "No merchant session. Sign-in is not configured and demo mode is off.",
    );
  }
  const row = await db.one<MerchantRow>(`SELECT id, name, timezone FROM merchant WHERE id = $1`, [DEMO_MERCHANT_ID]);
  if (!row) {
    throw new AppError("UNAVAILABLE", "Demo merchant is not seeded. Run: pnpm db:seed");
  }
  return {
    merchantId: row.id,
    merchantName: row.name,
    timezone: row.timezone,
    actor: DEMO_APPROVER,
    isDemoSession: true,
    user: null,
  };
}

export function assertOwnedByMerchant(ownerMerchantId: string, ctx: MerchantContext): void {
  if (ownerMerchantId !== ctx.merchantId) {
    throw new AppError("FORBIDDEN", "This resource belongs to a different merchant.");
  }
}
