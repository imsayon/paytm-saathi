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
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);

    const detail = await buildCampaignDetail(db, ctx, id);
    const approvalAt = detail.approval?.created_at ?? null;
    const firstImport = await db.one<{ imported_at: string }>(
      `SELECT imported_at FROM import_batch WHERE merchant_id = $1 ORDER BY imported_at ASC LIMIT 1`,
      [ctx.merchantId],
    );

    const setupSeconds =
      approvalAt && firstImport
        ? Math.max(0, Math.round((Date.parse(approvalAt) - Date.parse(firstImport.imported_at)) / 1000))
        : null;

    return NextResponse.json({
      campaign: detail.campaign,
      version: detail.version,
      proposal: detail.proposal,
      groups: { campaign: detail.groups.campaign.length, holdout: detail.groups.holdout.length },
      delivery: { summary: detail.job_summary, jobs: detail.jobs, provider: detail.provider },
      report: detail.report,
      setup_seconds: setupSeconds,
      audit: detail.audit,
    });
  });
}
