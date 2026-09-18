import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request, () => {
    const db = getDb();
    const merchants = (db.prepare(`SELECT COUNT(*) AS n FROM merchant`).get() as { n: number }).n;
    const queuedJobs = (
      db.prepare(`SELECT COUNT(*) AS n FROM delivery_job WHERE status IN ('QUEUED', 'PROCESSING', 'UNKNOWN')`).get() as {
        n: number;
      }
    ).n;

    return NextResponse.json({
      status: "ok",
      database: "ready",
      demo_mode: config.demoMode,
      planner: config.openAiApiKey ? "openai" : "template_fallback",
      seeded_merchants: merchants,
      pending_delivery_jobs: queuedJobs,
      live_provider_integrations: 0,
    });
  });
}
