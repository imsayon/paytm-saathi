import { z } from "zod";
import { NextResponse } from "next/server";
import { recordAudit } from "@/server/audit/events";
import { requireMerchantContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { seedMerchant } from "@/server/demo/fixture";
import { handle, rateLimit, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  customer_ids: z.array(z.string().trim().min(1).max(120)).max(20),
}).strict();

/** Saves the merchant-owned shortlist used by the next campaign draft. */
export async function PUT(request: Request) {
  return handle(request, async ({ requestId }) => {
    const db = getDb();
    await seedMerchant(db);
    const ctx = await requireMerchantContext(db);
    rateLimit(`importance:${ctx.merchantId}`, 30, 60_000);
    const body = await readJson(request, schema);
    const ids = [...new Set(body.customer_ids)];

    return db.transaction(async (tx) => {
      const owned = ids.length === 0
        ? []
        : await tx.all<{ id: string }>(
            `SELECT id FROM customer WHERE merchant_id = $1 AND id = ANY($2::text[])`,
            [ctx.merchantId, ids],
          );
      if (owned.length !== ids.length) {
        return NextResponse.json({ error: { message: "One or more selected customers do not belong to this workspace." } }, { status: 403 });
      }

      await tx.run(
        `UPDATE customer
            SET is_important = (id = ANY($2::text[]))
          WHERE merchant_id = $1`,
        [ctx.merchantId, ids],
      );
      await recordAudit(tx, {
        merchantId: ctx.merchantId,
        actor: ctx.actor,
        action: "customer.shortlist_updated",
        entity: `merchant:${ctx.merchantId}`,
        requestId,
        details: { selected_count: ids.length },
      });
      return NextResponse.json({ saved: true, selected_count: ids.length });
    });
  });
}
