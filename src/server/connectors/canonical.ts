import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { newId, type Db } from "../db/client";
import { localDate } from "../domain/time";
import { AppError } from "../errors";
import { recordAudit } from "../audit/events";

const sourceId = z.string().trim().min(1).max(200);
const isoDateTime = z.string().datetime({ offset: true });

export const canonicalPaymentSchema = z.object({
  source_event_id: sourceId,
  customer_ref: sourceId,
  customer_name: z.string().trim().min(1).max(120).optional(),
  contact_ref: z.string().trim().min(1).max(240).optional(),
  occurred_at: isoDateTime,
  amount_minor: z.number().int().nonnegative().max(2_147_483_647),
  currency: z.literal("INR"),
  status: z.enum(["settled", "refunded", "duplicate"]),
}).strict();

export const canonicalConsentSchema = z.object({
  source_event_id: sourceId,
  customer_ref: sourceId,
  purpose: z.literal("merchant_reengagement"),
  channel: z.enum(["sms", "whatsapp", "email", "in_app"]),
  state: z.enum(["granted", "denied", "unknown"]),
  captured_at: isoDateTime,
  expires_at: isoDateTime.optional(),
}).strict();

export const canonicalBatchSchema = z.object({
  source: z.string().trim().min(1).max(80),
  merchant_ref: sourceId,
  payments: z.array(canonicalPaymentSchema).max(20_000).default([]),
  consents: z.array(canonicalConsentSchema).max(20_000).default([]),
}).strict().refine((batch) => batch.payments.length > 0 || batch.consents.length > 0, {
  message: "At least one payment or consent event is required.",
  path: ["payments"],
});

export type CanonicalBatch = z.infer<typeof canonicalBatchSchema>;

type MerchantRow = { id: string; timezone: string };
type ExistingBatch = { id: string; row_count: number };

export type CanonicalIngestResult = {
  batchId: string;
  checksum: string;
  paymentEvents: number;
  consentEvents: number;
  duplicateEvents: number;
  alreadyImported: boolean;
};

export function connectorSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/**
 * Verifies a Paytm-facing request without trusting a browser session. The
 * sender signs `timestamp + "." + raw_body` with HMAC-SHA256 and sends:
 * x-saathi-timestamp: unix seconds
 * x-saathi-signature: sha256=<hex>
 */
export function verifyConnectorSignature(request: Request, rawBody: string, nowMs = Date.now()): void {
  const secret = config.connectorApiKey;
  if (!secret) throw new AppError("UNAVAILABLE", "The canonical connector is not configured on this deployment.");

  const timestamp = request.headers.get("x-saathi-timestamp")?.trim() ?? "";
  const signature = request.headers.get("x-saathi-signature")?.trim() ?? "";
  const seconds = Number(timestamp);
  if (!/^\d{10}$/.test(timestamp) || !Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1_000) > 5 * 60_000) {
    throw new AppError("UNAUTHENTICATED", "Connector request timestamp is missing or expired.");
  }

  const expected = connectorSignature(secret, timestamp, rawBody);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new AppError("UNAUTHENTICATED", "Connector request signature is invalid.");
  }
}

export function connectorChecksum(batch: CanonicalBatch): string {
  const stable = {
    source: batch.source,
    merchant_ref: batch.merchant_ref,
    payments: [...batch.payments].sort((a, b) => a.source_event_id.localeCompare(b.source_event_id)),
    consents: [...batch.consents].sort((a, b) => a.source_event_id.localeCompare(b.source_event_id)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Persists a normalized event batch into the same canonical tables used by
 * CSV imports. The connector never creates campaigns or sends messages; it
 * only updates source facts and preserves provider event identities.
 */
export async function ingestCanonicalBatch(
  db: Db,
  batch: CanonicalBatch,
  requestId?: string,
): Promise<CanonicalIngestResult> {
  const checksum = connectorChecksum(batch);
  return db.transaction(async (tx) => {
    const merchant = await tx.one<MerchantRow>(`SELECT id, timezone FROM merchant WHERE id = $1`, [batch.merchant_ref]);
    if (!merchant) throw new AppError("FORBIDDEN", "The connector merchant reference is not registered with Saathi.");

    const existing = await tx.one<ExistingBatch>(
      `SELECT id, row_count FROM import_batch WHERE merchant_id = $1 AND checksum = $2`,
      [merchant.id, checksum],
    );
    if (existing) {
      return {
        batchId: existing.id,
        checksum,
        paymentEvents: 0,
        consentEvents: 0,
        duplicateEvents: batch.payments.length + batch.consents.length,
        alreadyImported: true,
      };
    }

    const now = new Date().toISOString();
    const batchId = newId("imb");
    await tx.run(
      `INSERT INTO import_batch (id, merchant_id, checksum, source_name, row_count, imported_at, status, id_strategy)
       VALUES ($1, $2, $3, $4, $5, $6, 'published', 'file_payment_id')`,
      [batchId, merchant.id, checksum, `connector:${batch.source}`, batch.payments.length + batch.consents.length, now],
    );

    const customers = new Map<string, { name: string; contact: string | null }>();
    for (const payment of batch.payments) {
      const current = customers.get(payment.customer_ref);
      customers.set(payment.customer_ref, {
        name: payment.customer_name ?? current?.name ?? payment.customer_ref,
        contact: payment.contact_ref ?? current?.contact ?? null,
      });
    }
    for (const consent of batch.consents) {
      if (!customers.has(consent.customer_ref)) customers.set(consent.customer_ref, { name: consent.customer_ref, contact: null });
    }

    await tx.insertMany(
      "customer",
      ["id", "merchant_id", "external_id", "display_name", "contact_ref", "created_at"],
      [...customers.entries()].map(([externalId, customer]) => [
        newId("cus"),
        merchant.id,
        externalId,
        customer.name,
        customer.contact,
        now,
      ]),
      `ON CONFLICT (merchant_id, external_id)
       DO UPDATE SET display_name = excluded.display_name,
                     contact_ref = COALESCE(excluded.contact_ref, customer.contact_ref)`,
    );

    const customerIds = new Map(
      (
        await tx.all<{ id: string; external_id: string }>(
          `SELECT id, external_id FROM customer WHERE merchant_id = $1 AND external_id = ANY($2::text[])`,
          [merchant.id, [...customers.keys()]],
        )
      ).map((row) => [row.external_id, row.id] as const),
    );

    let paymentEvents = 0;
    let consentEvents = 0;
    let duplicateEvents = 0;

    for (const payment of batch.payments) {
      const event = await tx.one<{ id: string }>(
        `INSERT INTO connector_event (id, merchant_id, source, source_event_id, event_type, payload, received_at)
         VALUES ($1, $2, $3, $4, 'payment', $5::jsonb, $6)
         ON CONFLICT (merchant_id, source, source_event_id, event_type) DO NOTHING
         RETURNING id`,
        [newId("evt"), merchant.id, batch.source, payment.source_event_id, JSON.stringify(payment), now],
      );
      if (!event) {
        duplicateEvents += 1;
        continue;
      }
      const customerId = customerIds.get(payment.customer_ref);
      if (!customerId) throw new AppError("UNAVAILABLE", "A connector customer could not be resolved after upsert.");
      await tx.run(
        `INSERT INTO payment (id, merchant_id, payment_id, customer_id, paid_at, local_date, amount_minor, status, import_batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (merchant_id, payment_id) DO NOTHING`,
        [
          newId("pay"),
          merchant.id,
          `${batch.source}:${payment.source_event_id}`,
          customerId,
          new Date(payment.occurred_at).toISOString(),
          localDate(payment.occurred_at, merchant.timezone),
          payment.amount_minor,
          payment.status,
          batchId,
        ],
      );
      paymentEvents += 1;
    }

    for (const consent of batch.consents) {
      const event = await tx.one<{ id: string }>(
        `INSERT INTO connector_event (id, merchant_id, source, source_event_id, event_type, payload, received_at)
         VALUES ($1, $2, $3, $4, 'consent', $5::jsonb, $6)
         ON CONFLICT (merchant_id, source, source_event_id, event_type) DO NOTHING
         RETURNING id`,
        [newId("evt"), merchant.id, batch.source, consent.source_event_id, JSON.stringify(consent), now],
      );
      if (!event) {
        duplicateEvents += 1;
        continue;
      }
      const customerId = customerIds.get(consent.customer_ref);
      if (!customerId) throw new AppError("UNAVAILABLE", "A connector customer could not be resolved after upsert.");
      const expiresAt = consent.expires_at ? new Date(consent.expires_at).toISOString() : null;
      const state = expiresAt && Date.parse(expiresAt) <= Date.now()
        ? "unknown"
        : consent.state === "granted"
          ? "true"
          : consent.state === "denied"
            ? "false"
            : "unknown";
      await tx.run(
        `INSERT INTO consent
           (id, merchant_id, customer_id, state, source, observed_at, purpose, channel, expires_at, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [newId("con"), merchant.id, customerId, state, batch.source, consent.captured_at, consent.purpose, consent.channel, expiresAt, consent.source_event_id],
      );
      consentEvents += 1;
    }

    await recordAudit(tx, {
      merchantId: merchant.id,
      actor: `connector:${batch.source}`,
      action: "connector.events_ingested",
      entity: `import_batch:${batchId}`,
      newState: "published",
      requestId: requestId ?? null,
      details: {
        source: batch.source,
        payment_events: paymentEvents,
        consent_events: consentEvents,
        duplicate_events: duplicateEvents,
        checksum,
      },
    });

    return { batchId, checksum, paymentEvents, consentEvents, duplicateEvents, alreadyImported: false };
  });
}
