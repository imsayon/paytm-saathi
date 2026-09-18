import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { runOutcomeSimulation } from "@/server/domain/simulator";
import { buildCampaignDetail } from "@/server/domain/views";
import { handle, requireDemoMode } from "@/server/http";

export const dynamic = "force-dynamic";

/** Demo control only: advances the fixed clock and materializes the seven-day window. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async () => {
    requireDemoMode();
    const { id } = await params;
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const simulation = await runOutcomeSimulation(db, ctx, id);

    return NextResponse.json({
      simulation: { ...simulation, synthetic: true },
      campaign: await buildCampaignDetail(db, ctx, id),
    });
  });
}
