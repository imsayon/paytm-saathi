import { NextResponse } from "next/server";
import { config, describeDatabaseTarget } from "@/server/config";
import { getDb } from "@/server/db/client";
import { handle } from "@/server/http";
import { log } from "@/server/observability/log";

export const dynamic = "force-dynamic";

/**
 * Liveness plus a cheap database probe. Returns 503 when the database cannot be
 * reached so a load balancer or a presenter sees the problem before the demo does.
 */
export async function GET(request: Request) {
  return handle(request, async () => {
    const base = {
      demo_mode: config.demoMode,
      planner: config.openAiApiKey ? "openai" : "template_fallback",
      live_provider_integrations: 0,
    };

    if (!config.hasDatabaseUrl) {
      return NextResponse.json(
        { status: "degraded", database: "not_configured", ...base },
        { status: 503 },
      );
    }

    try {
      const db = getDb();
      const target = describeDatabaseTarget(config.databaseUrl);
      const [merchants, queued] = await Promise.all([
        db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM merchant`),
        db.one<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM delivery_job WHERE status IN ('QUEUED', 'PROCESSING', 'UNKNOWN')`,
        ),
      ]);
      return NextResponse.json({
        status: "ok",
        database: "ready",
        database_backend: "postgres",
        database_host: target.host,
        database_pooled: target.pooled,
        seeded_merchants: merchants?.n ?? 0,
        pending_delivery_jobs: queued?.n ?? 0,
        ...base,
      });
    } catch (error) {
      log("error", "healthz.database_unavailable", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return NextResponse.json(
        {
          status: "degraded",
          database: "unavailable",
          database_backend: "postgres",
          reason: error instanceof Error ? error.message : "unknown",
          ...base,
        },
        { status: 503 },
      );
    }
  });
}
