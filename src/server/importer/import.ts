import type { MerchantContext } from "../auth/context";
import { recordAudit } from "../audit/events";
import { config } from "../config";
import { inWriteTransaction, newId, type Db } from "../db/client";
import { localDate } from "../domain/time";
import { AppError } from "../errors";
import { parseCsv } from "./csv";

export type ImportResult = {
  batchId: string;
  checksum: string;
  rowCount: number;
  customerCount: number;
  idStrategy: "file_payment_id" | "derived_id";
  alreadyImported: boolean;
};

export function importCsv(
  db: Db,
  ctx: MerchantContext,
  input: { content: string; sourceName: string; requestId?: string },
): ImportResult {
  if (Buffer.byteLength(input.content, "utf8") > config.maxImportBytes) {
    throw new AppError("BAD_REQUEST", `CSV exceeds the ${config.maxImportBytes} byte import limit.`);
  }

  const parsed = parseCsv(input.content, { maxRows: config.maxImportRows });

  const foreignRow = parsed.rows.find((row) => row.merchantId !== ctx.merchantId);
  if (foreignRow) {
    throw new AppError(
      "FORBIDDEN",
      `Row ${foreignRow.rowNumber} belongs to merchant "${foreignRow.merchantId}", which is not the signed-in merchant.`,
      { row: foreignRow.rowNumber },
    );
  }

  const existing = db
    .prepare(`SELECT id, row_count, id_strategy FROM import_batch WHERE merchant_id = ? AND checksum = ?`)
    .get(ctx.merchantId, parsed.checksum) as
    | { id: string; row_count: number; id_strategy: "file_payment_id" | "derived_id" }
    | undefined;

  if (existing) {
    const customerCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM customer WHERE merchant_id = ?`).get(ctx.merchantId) as { n: number }
    ).n;
    return {
      batchId: existing.id,
      checksum: parsed.checksum,
      rowCount: existing.row_count,
      customerCount,
      idStrategy: existing.id_strategy,
      alreadyImported: true,
    };
  }

  const batchId = newId("imb");
  const now = new Date().toISOString();

  const customerCount = inWriteTransaction(db, () => {
    db.prepare(
      `INSERT INTO import_batch (id, merchant_id, checksum, source_name, row_count, imported_at, status, id_strategy)
       VALUES (?, ?, ?, ?, ?, ?, 'published', ?)`,
    ).run(batchId, ctx.merchantId, parsed.checksum, input.sourceName, parsed.rows.length, now, parsed.idStrategy);

    const upsertCustomer = db.prepare(
      `INSERT INTO customer (id, merchant_id, external_id, display_name, contact_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, external_id)
       DO UPDATE SET display_name = excluded.display_name, contact_ref = excluded.contact_ref`,
    );
    const findCustomer = db.prepare(`SELECT id FROM customer WHERE merchant_id = ? AND external_id = ?`);
    const insertConsent = db.prepare(
      `INSERT INTO consent (id, merchant_id, customer_id, state, source, observed_at) VALUES (?, ?, ?, ?, 'csv_import', ?)`,
    );
    const insertPayment = db.prepare(
      `INSERT INTO payment (id, merchant_id, payment_id, customer_id, paid_at, local_date, amount_minor, status, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, payment_id) DO NOTHING`,
    );

    const customerIds = new Map<string, string>();

    for (const row of parsed.rows) {
      let customerId = customerIds.get(row.customerId);
      if (!customerId) {
        upsertCustomer.run(
          newId("cus"),
          ctx.merchantId,
          row.customerId,
          row.customerName,
          row.contactRef,
          now,
        );
        customerId = (findCustomer.get(ctx.merchantId, row.customerId) as { id: string }).id;
        customerIds.set(row.customerId, customerId);
        insertConsent.run(newId("con"), ctx.merchantId, customerId, row.consent, row.paidAt);
      }

      insertPayment.run(
        newId("pay"),
        ctx.merchantId,
        row.paymentId,
        customerId,
        row.paidAt,
        localDate(row.paidAt, ctx.timezone),
        row.amountMinor,
        row.status,
        batchId,
      );
    }

    recordAudit(db, {
      merchantId: ctx.merchantId,
      actor: ctx.actor,
      action: "import.published",
      entity: `import_batch:${batchId}`,
      newState: "published",
      requestId: input.requestId ?? null,
      details: {
        source_name: input.sourceName,
        row_count: parsed.rows.length,
        customer_count: customerIds.size,
        id_strategy: parsed.idStrategy,
        checksum: parsed.checksum,
      },
    });

    return customerIds.size;
  });

  return {
    batchId,
    checksum: parsed.checksum,
    rowCount: parsed.rows.length,
    customerCount,
    idStrategy: parsed.idStrategy,
    alreadyImported: false,
  };
}
