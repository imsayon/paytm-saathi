import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { migrationsAreCurrent } from "@/server/db/migrate";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Readiness: the database answers and every migration file on disk has been
 * applied. Fails closed with 503 and names the pending migrations.
 */
export async function GET(request: Request) {
  return handle(request, async () => {
    if (!config.hasDatabaseUrl) {
      return NextResponse.json({ ready: false, reason: "DATABASE_URL is not configured." }, { status: 503 });
    }
    try {
      const status = await migrationsAreCurrent(getDb());
      if (!status.current) {
        return NextResponse.json(
          { ready: false, reason: "Pending migrations. Run: pnpm db:migrate", pending_migrations: status.pending },
          { status: 503 },
        );
      }
      return NextResponse.json({ ready: true, pending_migrations: [] });
    } catch (error) {
      return NextResponse.json(
        { ready: false, reason: "Database is unavailable. Please retry." },
        { status: 503 },
      );
    }
  });
}
