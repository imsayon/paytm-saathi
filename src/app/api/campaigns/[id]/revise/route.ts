import { z } from "zod";
import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { loadCampaign, loadVersion, reviseCampaign } from "@/server/domain/campaign";
import type { Proposal } from "@/server/domain/rules";
import { buildCampaignDetail } from "@/server/domain/views";
import { AppError } from "@/server/errors";
import { handle, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

/** Only these fields are merchant-editable. Audience membership is never edited by hand. */
const reviseSchema = z.object({
  reward_minor: z.number().int().min(0).max(100_000_000).optional(),
  valid_days: z.number().int().positive().max(60).optional(),
  weekday_only: z.boolean().optional(),
  timing: z.object({ local_start: z.string().max(5).optional(), local_end: z.string().max(5).optional() }).strict().optional(),
  copy: z.object({ headline: z.string().max(200).optional(), body: z.string().max(500).optional(), cta: z.string().max(80).optional() }).strict().optional(),
  copy_format: z.literal("separate_reward").optional(),
  budget_cap_minor: z.number().int().positive().max(2_147_483_647).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, "Provide at least one edit.");

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async ({ requestId }) => {
    const { id } = await params;
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const body = await readJson(request, reviseSchema);
    const campaign = await loadCampaign(db, ctx, id);
    const current = await loadVersion(db, campaign.id, campaign.current_version);
    const base: Proposal = current.proposal;

    if (body.reward_minor !== undefined && !Number.isInteger(body.reward_minor)) {
      throw new AppError("BAD_REQUEST", "reward_minor must be a whole number of paise.");
    }
    if (body.budget_cap_minor !== undefined && !Number.isInteger(body.budget_cap_minor)) {
      throw new AppError("BAD_REQUEST", "budget_cap_minor must be a whole number of paise.");
    }

    const proposal: Proposal = {
      ...base,
      copy_source: "merchant",
      copy_format: body.copy_format ?? base.copy_format,
      offer: {
        ...base.offer,
        amount_minor: body.reward_minor ?? base.offer.amount_minor,
        valid_days: body.valid_days ?? base.offer.valid_days,
        weekday_only: body.weekday_only ?? base.offer.weekday_only,
      },
      timing: {
        local_start: body.timing?.local_start ?? base.timing.local_start,
        local_end: body.timing?.local_end ?? base.timing.local_end,
      },
      copy: {
        headline: body.copy?.headline ?? base.copy.headline,
        body: body.copy?.body ?? base.copy.body,
        cta: body.copy?.cta ?? base.copy.cta,
      },
      // The merchant edited the plan, so the model's cost estimate no longer applies.
      model_estimated_cost_minor: null,
    };

    await reviseCampaign(db, ctx, {
      campaignId: campaign.id,
      proposal,
      budgetCapMinor: body.budget_cap_minor ?? current.cap_minor,
      requestId,
    });

    return NextResponse.json(await buildCampaignDetail(db, ctx, campaign.id), { status: 201 });
  });
}
