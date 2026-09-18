import { NextResponse } from "next/server";
import { recordAudit } from "@/server/audit/events";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { resetDemoData, seedMerchant } from "@/server/demo/fixture";
import { handle, requireDemoMode } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Demo control only. Clears the demo merchant's imported data, campaigns, jobs
 * and outcomes so the rehearsed sequence can start again from "Load demo CSV".
 * The database is shared and persistent, so this is the presenter's reset button.
 */
export async function POST(request: Request) {
  return handle(request, async ({ requestId }) => {
    requireDemoMode();
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const deleted = await resetDemoData(db, ctx.merchantId);
    await recordAudit(db, {
      merchantId: ctx.merchantId,
      actor: ctx.actor,
      action: "demo.reset",
      entity: `merchant:${ctx.merchantId}`,
      requestId,
      details: { deleted },
    });

    return NextResponse.json({ reset: true, deleted });
  });
}
