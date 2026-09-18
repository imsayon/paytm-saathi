import { z } from "zod";
import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { approveCampaign } from "@/server/domain/campaign";
import { buildCampaignDetail } from "@/server/domain/views";
import { AppError } from "@/server/errors";
import { handle, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const approveSchema = z.object({ version: z.number().int().positive() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, async ({ requestId }) => {
    const { id } = await params;
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      throw new AppError("BAD_REQUEST", "An Idempotency-Key header is required to approve a campaign.");
    }

    const body = await readJson(request, approveSchema);
    if (!Number.isInteger(body.version)) {
      throw new AppError("BAD_REQUEST", "version must be the integer version number being approved.");
    }

    const result = await approveCampaign(db, ctx, {
      campaignId: id,
      version: body.version!,
      idempotencyKey,
      requestId,
    });

    return NextResponse.json({
      approval: {
        id: result.approvalId,
        version: result.version,
        version_id: result.versionId,
        status: result.status,
        jobs_queued: result.jobsQueued,
        replayed: result.replayed,
        provider_called: false,
      },
      campaign: await buildCampaignDetail(db, ctx, id),
    });
  });
}
