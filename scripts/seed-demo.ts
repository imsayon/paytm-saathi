import { requireMerchantContext } from "../src/server/auth/context";
import { config } from "../src/server/config";
import { openDatabase } from "../src/server/db/client";
import { DEMO_AS_OF, FIXTURE_NAME, readFixture, seedMerchant } from "../src/server/demo/fixture";
import { computeSignal } from "../src/server/domain/signal";
import { importCsv } from "../src/server/importer/import";

const db = openDatabase();
seedMerchant(db);

const ctx = requireMerchantContext(db);
const result = importCsv(db, ctx, { content: readFixture(), sourceName: FIXTURE_NAME });
const signal = computeSignal(db, ctx.merchantId, DEMO_AS_OF);

console.log(
  JSON.stringify(
    {
      database: config.dbPath,
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
db.close();
