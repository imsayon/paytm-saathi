import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { neonAuthConfigured } from "@/server/auth/neon";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { AppError } from "@/server/errors";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

/** Who the header should show. Never throws for an anonymous visitor. */
export async function GET(request: Request) {
  return handle(request, async () => {
    const db = getDb();
    await seedMerchant(db);
    try {
      const ctx = await requireMerchantContext(db);
      return NextResponse.json({
        signed_in: ctx.user !== null,
        auth_configured: neonAuthConfigured(),
        demo_mode: config.demoMode,
        merchant: { id: ctx.merchantId, name: ctx.merchantName, demo_session: ctx.isDemoSession },
        user: ctx.user ? { email: ctx.user.email } : null,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
        return NextResponse.json({ signed_in: false, auth_configured: neonAuthConfigured(), demo_mode: config.demoMode, merchant: null, user: null });
      }
      throw error;
    }
  });
}
