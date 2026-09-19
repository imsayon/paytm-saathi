import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { loadCampaign } from "@/server/domain/campaign";
import { buildCampaignDetail } from "@/server/domain/views";
import { handle, requireDemoMode } from "@/server/http";
import { describeDeliveryProvider } from "@/server/providers";
import { drainQueue } from "@/server/worker/runner";

export const dynamic = "force-dynamic";

/**
 * Demo control only. In a real deployment the worker process drains the queue;
 * this endpoint exists so a presenter does not need a second terminal.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async () => {
    requireDemoMode();
    const { id } = await params;
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    await loadCampaign(db, ctx, id);

    const summary = await drainQueue(db, { workerId: "demo-control" });

    const provider = describeDeliveryProvider();
    return NextResponse.json({
      worker: { ...summary, provider: provider.name, live_messages_sent: provider.live ? summary.delivered : 0 },
      campaign: await buildCampaignDetail(db, ctx, id),
    });
  });
}
