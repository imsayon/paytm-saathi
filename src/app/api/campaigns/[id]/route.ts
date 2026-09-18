import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { buildCampaignDetail } from "@/server/domain/views";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async () => {
    const { id } = await params;
    const db = getDb();
    seedMerchant(db);
    const ctx = requireMerchantContext(db);
    return NextResponse.json(buildCampaignDetail(db, ctx, id));
  });
}
