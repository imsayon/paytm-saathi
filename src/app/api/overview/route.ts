import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { DEMO_AS_OF, DEMO_BUDGET_CAP_MINOR, DEMO_INTENT, seedMerchant } from "@/server/demo/fixture";
import { computeSignal } from "@/server/domain/signal";
import { signalView } from "@/server/domain/views";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request, async () => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const [lastImport, campaigns] = await Promise.all([
      db.one<{ id: string; source_name: string; row_count: number; imported_at: string; id_strategy: string }>(
        `SELECT id, source_name, row_count, imported_at, id_strategy FROM import_batch
          WHERE merchant_id = $1 ORDER BY imported_at DESC LIMIT 1`,
        [ctx.merchantId],
      ),
      db.all<{ id: string; intent: string; status: string; current_version: number; created_at: string }>(
        `SELECT id, intent, status, current_version, created_at FROM campaign
          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [ctx.merchantId],
      ),
    ]);

    const signal = lastImport ? signalView(await computeSignal(db, ctx.merchantId, DEMO_AS_OF)) : null;

    return NextResponse.json({
      merchant: {
        id: ctx.merchantId,
        name: ctx.merchantName,
        timezone: ctx.timezone,
        demo_session: ctx.isDemoSession,
      },
      demo: {
        as_of: DEMO_AS_OF,
        suggested_intent: DEMO_INTENT,
        suggested_budget_cap_minor: DEMO_BUDGET_CAP_MINOR,
        demo_mode: config.demoMode,
        planner: config.geminiApiKey ? "gemini" : "template_fallback",
      },
      last_import: lastImport ?? null,
      signal,
      campaigns,
    });
  });
}
