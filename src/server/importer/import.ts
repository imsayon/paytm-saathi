import type { MerchantContext } from "../auth/context";
import { recordAudit } from "../audit/events";
import { config } from "../config";
import { newId, type Db } from "../db/client";
import { localDate } from "../domain/time";
import { AppError } from "../errors";
import { parseCsv, type ParsedRow } from "./csv";

export type ImportResult = {
  batchId: string;
  checksum: string;
  rowCount: number;
  customerCount: number;
  idStrategy: "file_payment_id" | "derived_id";
  alreadyImported: boolean;
};

export async function importCsv(
  db: Db,
  ctx: MerchantContext,
  input: { content: string; sourceName: string; requestId?: string },
): Promise<ImportResult> {
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

  const existing = await db.one<{ id: string; row_count: number; id_strategy: "file_payment_id" | "derived_id" }>(
    `SELECT id, row_count, id_strategy FROM import_batch WHERE merchant_id = $1 AND checksum = $2`,
    [ctx.merchantId, parsed.checksum],
  );

  if (existing) {
    const customerCount = await countCustomers(db, ctx.merchantId);
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

  // Payment files repeat customer fields on every row. Keep the latest consent
  // state and merge the profile while preserving the payment rows themselves.
  const firstRowByCustomer = new Map<string, ParsedRow>();
  for (const row of parsed.rows) {
    const existing = firstRowByCustomer.get(row.customerId);
    if (!existing) {
      firstRowByCustomer.set(row.customerId, { ...row, customerProfile: { ...row.customerProfile } });
      continue;
    }
    existing.contactRef ??= row.contactRef;
    existing.isImportant ||= row.isImportant;
    existing.importanceNote ??= row.importanceNote;
    existing.customerProfile = { ...existing.customerProfile, ...row.customerProfile };
    if (row.paidAt > existing.paidAt) {
      existing.consent = row.consent;
      existing.consentChannel = row.consentChannel;
      existing.consentExpiresAt = row.consentExpiresAt;
    }
  }

  const customerCount = await db.transaction(async (tx) => {
    // Publishing the batch row first means a duplicate concurrent import of the
    // same file fails on the checksum index before it writes any payments.
    await tx.run(
      `INSERT INTO import_batch (id, merchant_id, checksum, source_name, row_count, imported_at, status, id_strategy)
       VALUES ($1, $2, $3, $4, $5, $6, 'published', $7)`,
      [batchId, ctx.merchantId, parsed.checksum, input.sourceName, parsed.rows.length, now, parsed.idStrategy],
    );

    await tx.insertMany(
      "customer",
      ["id", "merchant_id", "external_id", "display_name", "contact_ref", "is_important", "importance_note", "profile", "created_at"],
      [...firstRowByCustomer.values()].map((row) => [
        newId("cus"),
        ctx.merchantId,
        row.customerId,
        row.customerName,
        row.contactRef,
        row.isImportant,
        row.importanceNote,
        JSON.stringify(row.customerProfile),
        now,
      ]),
      `ON CONFLICT (merchant_id, external_id)
       DO UPDATE SET display_name = excluded.display_name,
                     contact_ref = COALESCE(excluded.contact_ref, customer.contact_ref),
                     is_important = customer.is_important OR excluded.is_important,
                     importance_note = COALESCE(excluded.importance_note, customer.importance_note),
                     profile = customer.profile || excluded.profile`,
    );

    const customerIds = new Map(
      (
        await tx.all<{ id: string; external_id: string }>(
          `SELECT id, external_id FROM customer WHERE merchant_id = $1 AND external_id = ANY($2::text[])`,
          [ctx.merchantId, [...firstRowByCustomer.keys()]],
        )
      ).map((row) => [row.external_id, row.id] as const),
    );

    await tx.insertMany(
      "consent",
      ["id", "merchant_id", "customer_id", "state", "source", "observed_at", "purpose", "channel", "expires_at"],
      [...firstRowByCustomer.values()].map((row) => [
        newId("con"),
        ctx.merchantId,
        customerIds.get(row.customerId)!,
        row.consent,
        "csv_import",
        row.paidAt,
        "merchant_reengagement",
        row.consentChannel,
        row.consentExpiresAt,
      ]),
    );

    await tx.insertMany(
      "payment",
      ["id", "merchant_id", "payment_id", "customer_id", "paid_at", "local_date", "amount_minor", "status", "import_batch_id"],
      parsed.rows.map((row) => [
        newId("pay"),
        ctx.merchantId,
        row.paymentId,
        customerIds.get(row.customerId)!,
        row.paidAt,
        localDate(row.paidAt, ctx.timezone),
        row.amountMinor,
        row.status,
        batchId,
      ]),
      `ON CONFLICT (merchant_id, payment_id) DO NOTHING`,
    );

    await recordAudit(tx, {
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

async function countCustomers(db: Db, merchantId: string): Promise<number> {
  const row = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customer WHERE merchant_id = $1`, [merchantId]);
  return row?.n ?? 0;
}
