import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getDb, newId } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { handle } from "@/server/http";
import { log } from "@/server/observability/log";
import { validTwilioSignature } from "@/server/providers/twilio";
import { refreshCampaignDeliveryStatus } from "@/server/worker/runner";

export const dynamic = "force-dynamic";

const DELIVERED = new Set(["delivered", "read"]);
const FAILED = new Set(["failed", "undelivered", "canceled"]);

/**
 * Twilio's status callback. Verified against the auth token, idempotent under
 * Twilio's retries, and only ever moves a job that is still waiting on the
 * carrier (UNKNOWN or NEEDS_REVIEW) to its terminal state. It never sends
 * anything and never creates a job.
 */
export async function POST(request: Request) {
  return handle(request, async () => {
    if (config.deliveryProvider !== "twilio" || !config.twilioAuthToken) {
      throw new AppError("NOT_FOUND", "Twilio delivery is not enabled.");
    }
    const form = await request.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) params[key] = String(value);

    const url = config.publicBaseUrl ? `${config.publicBaseUrl}/api/providers/twilio/status` : request.url;
    if (!validTwilioSignature(config.twilioAuthToken, url, params, request.headers.get("x-twilio-signature"))) {
      throw new AppError("FORBIDDEN", "Invalid provider signature.");
    }

    const sid = params.MessageSid ?? params.SmsSid;
    const status = (params.MessageStatus ?? params.SmsStatus ?? "").toLowerCase();
    if (!sid || !status) throw new AppError("BAD_REQUEST", "MessageSid and MessageStatus are required.");

    const terminal = DELIVERED.has(status) ? "DELIVERED" : FAILED.has(status) ? "FAILED" : null;
    if (!terminal) return NextResponse.json({ received: true, applied: false, reason: "not_terminal" });

    const db = getDb();
    const applied = await db.transaction(async (tx) => {
      const job = await tx.one<{ id: string; merchant_id: string; campaign_id: string; version_id: string; status: string; attempt_count: number }>(
        `SELECT j.id, j.merchant_id, j.campaign_id, j.version_id, j.status, j.attempt_count
           FROM delivery_job j
           JOIN delivery_attempt a ON a.job_id = j.id
          WHERE a.provider_message_id = $1
          ORDER BY a.attempt_no DESC LIMIT 1
          FOR UPDATE OF j`,
        [sid],
      );
      if (!job) return "unknown_message";
      if (!["UNKNOWN", "NEEDS_REVIEW", "PROCESSING"].includes(job.status)) return "already_terminal";

      const now = new Date().toISOString();
      const attemptNo = job.attempt_count + 1;
      await tx.run(
        `WITH attempt AS (
           INSERT INTO delivery_attempt (id, job_id, attempt_no, outcome, provider_message_id, provider_response, started_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ), job AS (
           UPDATE delivery_job SET status = $8, attempt_count = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = $7 WHERE id = $2
         )
         INSERT INTO audit_event
           (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details, created_at)
         VALUES ($9, $10, $11, $12, $2, 'provider', $13, $14, $15, $8, NULL, $16::jsonb, $7)`,
        [
          newId("att"),
          job.id,
          attemptNo,
          `webhook_${status}`,
          sid,
          JSON.stringify({ provider: "twilio", status, error_code: params.ErrorCode ?? null }),
          now,
          terminal,
          newId("aud"),
          job.merchant_id,
          job.campaign_id,
          job.version_id,
          terminal === "DELIVERED" ? "delivery.status_confirmed_delivered" : "delivery.failed",
          `delivery_job:${job.id}`,
          job.status,
          JSON.stringify({ provider: "twilio", via: "status_callback", status, error_code: params.ErrorCode ?? null }),
        ],
      );
      return job.campaign_id;
    });

    if (applied !== "unknown_message" && applied !== "already_terminal") {
      await refreshCampaignDeliveryStatus(db, applied);
    }
    log("info", "twilio.status_callback", { status, applied: applied !== "unknown_message" && applied !== "already_terminal" });
    return NextResponse.json({ received: true, applied: applied !== "unknown_message" && applied !== "already_terminal", reason: applied.startsWith("cmp_") ? null : applied });
  });
}
