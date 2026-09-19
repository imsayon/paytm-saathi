import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { DEMO_AS_OF, DEMO_BUDGET_CAP_MINOR, DEMO_INTENT, seedMerchant } from "@/server/demo/fixture";
import { computeSignal } from "@/server/domain/signal";
import { signalView } from "@/server/domain/views";
import { asOfFor } from "@/server/demo/synth";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request, async () => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const [merchantSettings, lastImport, campaigns, latestSynthetic, memory, integration] = await Promise.all([
      db.one<{ default_cap_minor: number }>(`SELECT default_cap_minor FROM merchant WHERE id = $1`, [ctx.merchantId]),
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
      db.one<{ id: string; seed: number; persona: Record<string, unknown>; persona_source: string; row_count: number; customer_count: number; created_at: string }>(
        `SELECT id, seed, persona, persona_source, row_count, customer_count, created_at
           FROM synthetic_dataset
          WHERE merchant_id = $1 AND import_batch_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.merchantId],
      ),
      db.one<{ facts: number }>(`SELECT COUNT(*)::int AS facts FROM merchant_memory WHERE merchant_id = $1`, [ctx.merchantId]),
      db.one<{ pending: number; last_event_at: string | null }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, MAX(created_at) AS last_event_at
           FROM integration_event WHERE merchant_id = $1`,
        [ctx.merchantId],
      ),
    ]);

    const asOf = asOfFor(ctx);
    const signal = lastImport ? signalView(await computeSignal(db, ctx.merchantId, asOf)) : null;

    return NextResponse.json({
      merchant: {
        id: ctx.merchantId,
        name: ctx.merchantName,
        timezone: ctx.timezone,
        demo_session: ctx.isDemoSession,
      },
      demo: {
        as_of: asOf,
        suggested_intent: DEMO_INTENT,
        suggested_budget_cap_minor: merchantSettings?.default_cap_minor ?? DEMO_BUDGET_CAP_MINOR,
        demo_mode: config.demoMode,
        planner: config.geminiApiKey ? "gemini" : "template_fallback",
      },
      last_import: lastImport ?? null,
      latest_synthetic: latestSynthetic ?? null,
      memory: { facts: memory?.facts ?? 0 },
      integrations: {
        n8n: {
          configured: Boolean(config.n8nWebhookUrl && config.n8nSecret),
          pending_events: integration?.pending ?? 0,
          last_event_at: integration?.last_event_at ?? null,
        },
        cognee: { configured: Boolean(config.cogneeBaseUrl && config.cogneeApiKey) },
      },
      signal,
      campaigns,
    });
  });
}
