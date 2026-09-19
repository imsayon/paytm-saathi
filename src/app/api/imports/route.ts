import { z } from "zod";
import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { DEMO_AS_OF, FIXTURE_NAME, readFixture, seedMerchant } from "@/server/demo/fixture";
import { computeSignal } from "@/server/domain/signal";
import { signalView } from "@/server/domain/views";
import { AppError } from "@/server/errors";
import { asOfFor } from "@/server/demo/synth";
import { handle, rateLimit, readJson } from "@/server/http";
import { importCsv } from "@/server/importer/import";

export const dynamic = "force-dynamic";

const importSchema = z.object({
  use_fixture: z.boolean().optional(),
  csv: z.string().optional(),
  source_name: z.string().trim().min(1).max(200).optional(),
}).strict().refine((body) => body.use_fixture === true ? body.csv === undefined : Boolean(body.csv), "Provide either use_fixture: true or a csv string.");

export async function POST(request: Request) {
  return handle(request, async ({ requestId }) => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    rateLimit(`import:${ctx.merchantId}`, 10, 60_000);

    const body = await readJson(request, importSchema);
    if (!body.use_fixture && !body.csv) {
      throw new AppError("BAD_REQUEST", "Provide either use_fixture: true or a csv string.");
    }
    if (body.csv !== undefined && typeof body.csv !== "string") {
      throw new AppError("BAD_REQUEST", "csv must be a string containing the file contents.");
    }

    const content = body.use_fixture ? readFixture() : body.csv!;
    const sourceName = body.use_fixture ? FIXTURE_NAME : (body.source_name ?? "upload.csv");

    const result = await importCsv(db, ctx, { content, sourceName, requestId });
    const signal = await computeSignal(db, ctx.merchantId, asOfFor(ctx));

    return NextResponse.json(
      {
        import: {
          batch_id: result.batchId,
          checksum: result.checksum,
          row_count: result.rowCount,
          customer_count: result.customerCount,
          id_strategy: result.idStrategy,
          already_imported: result.alreadyImported,
          source_name: sourceName,
        },
        signal: signalView(signal),
      },
      { status: result.alreadyImported ? 200 : 201 },
    );
  });
}
