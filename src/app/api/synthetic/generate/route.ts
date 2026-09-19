import { z } from "zod";
import { NextResponse } from "next/server";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { asOfFor, generateAndImport } from "@/server/demo/synth";
import { computeSignal } from "@/server/domain/signal";
import { signalView } from "@/server/domain/views";
import { handle, rateLimit, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    seed: z.number().int().min(1).max(2_147_483_647).optional(),
    customers: z.number().int().min(20).max(2_500).optional(),
    rows: z.number().int().min(100).max(10_000).optional(),
    absent_share: z.number().min(0.1).max(0.5).optional(),
    replace: z.boolean().optional(),
  })
  .strict();

/** Builds a fresh synthetic merchant dataset and imports it for the acting merchant. */
export async function POST(request: Request) {
  return handle(request, async ({ requestId }) => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    rateLimit(`synthetic:${ctx.merchantId}`, 6, 60_000);
    const body = await readJson(request, schema);
    const generated = await generateAndImport(db, ctx, {
      seed: body.seed,
      customers: body.customers,
      rows: body.rows,
      absentShare: body.absent_share,
      replace: body.replace ?? true,
      requestId,
    });
    const signal = await computeSignal(db, ctx.merchantId, asOfFor(ctx));
    return NextResponse.json({ synthetic: generated, signal: signalView(signal) }, { status: 201 });
  });
}
