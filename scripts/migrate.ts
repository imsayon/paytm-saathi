import { config, describeDatabaseTarget } from "../src/server/config";
import { createPool, Db } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";

async function main(): Promise<void> {
  const url = config.migrationDatabaseUrl;
  const target = describeDatabaseTarget(url);
  if (target.pooled) {
    console.warn(
      "warning: running migrations over the pooled endpoint; set DATABASE_URL_UNPOOLED to the direct Neon connection for schema work.",
    );
  }
  const pool = createPool(url, { max: 1 });
  const db = new Db(pool);
  try {
    const outcome = await runMigrations(db);
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    console.log(
      JSON.stringify(
        {
          database: target.database,
          host: target.host,
          applied: outcome.applied,
          already_applied: outcome.alreadyApplied,
          tables: tables.map((row) => row.table_name),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
