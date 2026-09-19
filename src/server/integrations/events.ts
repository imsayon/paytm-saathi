import crypto from "node:crypto";
import { config } from "../config";
import { newId, type Db } from "../db/client";
import { log } from "../observability/log";

/**
 * Domain events an automation may react to. They are written in the same
 * transaction as the audit event they mirror, so n8n can never see a
 * transition that did not commit, and they are retained forever. Payloads are
 * the audit details: aggregate counts and identifiers, never a contact
 * reference or a customer identifier.
 */
export const INTEGRATION_ACTIONS = new Set([
  "import.published",
  "campaign.created",
  "campaign.version_changed",
  "campaign.approved",
  "jobs.queued",
  "campaign.delivery_status_changed",
  "delivery.needs_review",
  "report.generated",
  "demo.reset",
]);

export async function recordIntegrationEvent(
  db: Db,
  input: { merchantId: string; campaignId?: string | null; event: string; payload: Record<string, unknown> },
): Promise<void> {
  await db.run(
    `INSERT INTO integration_event (id, merchant_id, campaign_id, event, payload, status, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      newId("evt"),
      input.merchantId,
      input.campaignId ?? null,
      input.event,
      JSON.stringify(input.payload),
      config.n8nWebhookUrl && config.n8nSecret ? "pending" : "skipped",
      new Date().toISOString(),
    ],
  );
}

export function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const MAX_ATTEMPTS = 5;

/**
 * Posts pending events to N8N_WEBHOOK_URL, signed with the shared secret.
 * Claims rows with SKIP LOCKED so the app and the worker can both run it; a
 * failure is retried on a later pass and given up after five attempts.
 */
export async function dispatchPendingEvents(db: Db, options: { fetchImpl?: typeof fetch; limit?: number } = {}): Promise<{ delivered: number; failed: number }> {
  const url = config.n8nWebhookUrl;
  const secret = config.n8nSecret;
  const summary = { delivered: 0, failed: 0 };
  if (!url || !secret) return summary;
  const fetchImpl = options.fetchImpl ?? fetch;

  const rows = await db.all<{ id: string; merchant_id: string; campaign_id: string | null; event: string; payload: Record<string, unknown>; attempts: number; created_at: string }>(
    `UPDATE integration_event SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM integration_event WHERE status = 'pending' AND attempts < $1 ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, merchant_id, campaign_id, event, payload, attempts, created_at`,
    [MAX_ATTEMPTS, options.limit ?? 20],
  );

  for (const row of rows) {
    const body = JSON.stringify({
      id: row.id,
      event: row.event,
      merchant_id: row.merchant_id,
      campaign_id: row.campaign_id,
      occurred_at: row.created_at,
      payload: row.payload,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-saathi-event": row.event, "x-saathi-signature": signBody(secret, body) },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await db.run(`UPDATE integration_event SET status = 'delivered', delivered_at = $1, last_error = NULL WHERE id = $2`, [new Date().toISOString(), row.id]);
      summary.delivered += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 120) : "unknown";
      await db.run(`UPDATE integration_event SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END, last_error = $2 WHERE id = $3`, [MAX_ATTEMPTS, reason, row.id]);
      summary.failed += 1;
      log("warn", "integration.dispatch_failed", { event: row.event, attempt: row.attempts, reason });
    } finally {
      clearTimeout(timer);
    }
  }
  return summary;
}

/** Fire-and-forget after a request commits; never delays the response. */
export function dispatchSoon(db: Db): void {
  if (!config.n8nWebhookUrl || !config.n8nSecret) return;
  setTimeout(() => {
    dispatchPendingEvents(db).catch((error) => log("warn", "integration.dispatch_error", { reason: error instanceof Error ? error.name : "unknown" }));
  }, 0);
}
