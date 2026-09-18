import { z } from "zod";
import { NextResponse } from "next/server";
import { buildPlannerInput, runPlanner } from "@/server/ai/planner";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { DEMO_AS_OF, DEMO_BUDGET_CAP_MINOR, seedMerchant } from "@/server/demo/fixture";
import { createCampaignPreview } from "@/server/domain/campaign";
import { computeSignal } from "@/server/domain/signal";
import { isValidDateString } from "@/server/domain/time";
import { buildCampaignDetail } from "@/server/domain/views";
import { AppError } from "@/server/errors";
import { handle, rateLimit, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  intent: z.string().trim().min(5).max(500),
  budget_cap_minor: z.number().int().positive().max(2_147_483_647).optional(),
  as_of: z.string().refine(isValidDateString, "Use a valid YYYY-MM-DD date").optional(),
}).strict();

export async function POST(request: Request) {
  return handle(request, async ({ requestId }) => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    rateLimit(`preview:${ctx.merchantId}`, 20, 60_000);

    const body = await readJson(request, previewSchema);
    const intent = (body.intent ?? "").trim();
    const budgetCapMinor = body.budget_cap_minor ?? DEMO_BUDGET_CAP_MINOR;
    const asOf = body.as_of ?? DEMO_AS_OF;

    if (intent.length < 5 || intent.length > 500) {
      throw new AppError("BAD_REQUEST", "Intent must be between 5 and 500 characters.");
    }
    if (!Number.isInteger(budgetCapMinor) || budgetCapMinor <= 0) {
      throw new AppError("BAD_REQUEST", "budget_cap_minor must be a positive whole number of paise.");
    }
    if (!isValidDateString(asOf)) {
      throw new AppError("BAD_REQUEST", "as_of must be a YYYY-MM-DD date.");
    }

    const hasImport = await db.one(`SELECT id FROM import_batch WHERE merchant_id = $1 LIMIT 1`, [ctx.merchantId]);
    if (!hasImport) {
      throw new AppError("RULE_VIOLATION", "Import payment data before creating a campaign.");
    }

    const signal = await computeSignal(db, ctx.merchantId, asOf);
    const plannerInput = buildPlannerInput({ intent, signal, budgetCapMinor, timezone: ctx.timezone });
    const planner = await runPlanner(plannerInput);

    const { campaignId } = await createCampaignPreview(db, ctx, {
      intent,
      budgetCapMinor,
      asOf,
      proposal: planner.proposal,
      aiSource: planner.source,
      fallbackReason: planner.fallbackReason,
      requestId,
    });

    return NextResponse.json(
      {
        ...(await buildCampaignDetail(db, ctx, campaignId)),
        planner: {
          source: planner.source,
          fallback_reason: planner.fallbackReason,
          latency_ms: planner.latencyMs,
          model: planner.model,
          sent_fields: Object.keys(plannerInput),
          contact_data_sent: false,
        },
      },
      { status: 201 },
    );
  });
}
