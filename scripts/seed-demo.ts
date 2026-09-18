import { requireMerchantContext } from "../src/server/auth/context";
import { config, describeDatabaseTarget } from "../src/server/config";
import { closeDb, getDb } from "../src/server/db/client";
import { migrationsAreCurrent } from "../src/server/db/migrate";
import { DEMO_AS_OF, FIXTURE_NAME, readFixture, seedMerchant } from "../src/server/demo/fixture";
import { computeSignal } from "../src/server/domain/signal";
import { importCsv } from "../src/server/importer/import";

async function main(): Promise<void> {
  const db = getDb();
  const migrations = await migrationsAreCurrent(db);
  if (!migrations.current) {
    throw new Error(`Pending migrations: ${migrations.pending.join(", ")}. Run: npm run db:migrate`);
  }

  await seedMerchant(db);
  const ctx = await requireMerchantContext(db);
  const result = await importCsv(db, ctx, { content: readFixture(), sourceName: FIXTURE_NAME });
  const signal = await computeSignal(db, ctx.merchantId, DEMO_AS_OF);
  const target = describeDatabaseTarget(config.databaseUrl);

  console.log(
    JSON.stringify(
      {
        database: target.database,
        host: target.host,
        merchant: ctx.merchantName,
        import: result,
        signal: {
          as_of: signal.asOf,
          total_customers: signal.totalCustomers,
          regular_customers: signal.regularCustomers,
          absent_regulars: signal.absentRegulars,
          eligible: signal.eligibleCount,
          excluded: signal.excluded,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
