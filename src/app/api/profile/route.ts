import { z } from "zod";
import { NextResponse } from "next/server";
import { recordAudit } from "@/server/audit/events";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { AppError } from "@/server/errors";
import { handle, rateLimit, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).max(80),
  default_cap_minor: z.number().int().positive().max(2_147_483_647),
}).strict();

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  return handle(request, async () => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    const merchant = await db.one<{ name: string; timezone: string; default_cap_minor: number; email: string | null; phone: string | null }>(
      `SELECT name, timezone, default_cap_minor, email, phone FROM merchant WHERE id = $1`,
      [ctx.merchantId],
    );
    if (!merchant) throw new AppError("NOT_FOUND", "Merchant profile not found.");
    return NextResponse.json({ profile: merchant, user: ctx.user ? { email: ctx.user.email } : null });
  });
}

export async function PATCH(request: Request) {
  return handle(request, async ({ requestId }) => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    rateLimit(`profile:${ctx.merchantId}`, 20, 60_000);
    const body = await readJson(request, updateSchema);
    if (!validTimezone(body.timezone)) throw new AppError("BAD_REQUEST", "Choose a valid timezone.");

    const profile = await db.transaction(async (tx) => {
      const updated = await tx.one<{ name: string; timezone: string; default_cap_minor: number; email: string | null; phone: string | null }>(
        `UPDATE merchant
            SET name = $1, timezone = $2, default_cap_minor = $3
          WHERE id = $4
        RETURNING name, timezone, default_cap_minor, email, phone`,
        [body.name, body.timezone, body.default_cap_minor, ctx.merchantId],
      );
      await recordAudit(tx, {
        merchantId: ctx.merchantId,
        actor: ctx.actor,
        action: "merchant.profile_updated",
        entity: `merchant:${ctx.merchantId}`,
        requestId,
        details: { timezone: body.timezone, default_cap_minor: body.default_cap_minor },
      });
      return updated;
    });
    return NextResponse.json({ profile, saved: true });
  });
}
