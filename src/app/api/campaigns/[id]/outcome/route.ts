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

    const detail = buildCampaignDetail(db, ctx, id);
    const approvalAt = detail.approval?.created_at ?? null;
    const firstImport = db
      .prepare(`SELECT imported_at FROM import_batch WHERE merchant_id = ? ORDER BY imported_at ASC LIMIT 1`)
      .get(ctx.merchantId) as { imported_at: string } | undefined;

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
