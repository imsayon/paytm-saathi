import crypto from "node:crypto";
import { config } from "../config";
import { log } from "../observability/log";
import type { DeliveryProvider, SendRequest, SendResult, StatusHint, StatusResult } from "./types";

/**
 * Twilio Programmable Messaging (SMS and WhatsApp) behind the same contract as
 * the mock. What it promises the worker:
 *
 * - `send` returns `delivered` only when Twilio reports a terminal delivered
 *   state within the wait window, `failed` on a terminal failure, and
 *   `timeout` otherwise, carrying the Message SID so the retry pass can ask
 *   for status instead of sending again.
 * - `getStatus` needs the SID (the worker passes the last recorded one). With
 *   no SID there is nothing safe to look up, so it answers `unavailable` and
 *   the job stops in NEEDS_REVIEW rather than risking a duplicate.
 * - The provider never logs a recipient, and the raw response it hands back
 *   for storage has the phone numbers removed.
 *
 * Only routable contact references are sent: `+E164`, `sms:+E164` or
 * `whatsapp:+E164`. The synthetic fixture (`synthetic-sms:...`) is refused as
 * a terminal failure, so the demo data can never reach a phone.
 */

const TERMINAL_DELIVERED = new Set(["delivered", "read"]);
const TERMINAL_FAILED = new Set(["failed", "undelivered", "canceled"]);
const E164 = /^\+[1-9]\d{6,14}$/;

export type TwilioSettings = {
  accountSid: string;
  authToken: string;
  from: string;
  sendWaitMs: number;
  statusCallbackUrl: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function twilioSettingsFromEnv(): TwilioSettings {
  const missing = [
    !config.twilioAccountSid && "TWILIO_ACCOUNT_SID",
    !config.twilioAuthToken && "TWILIO_AUTH_TOKEN",
    !config.twilioFrom && "TWILIO_FROM",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`SAATHI_DELIVERY_PROVIDER=twilio needs ${missing.join(", ")} in .env.`);
  }
  return {
    accountSid: config.twilioAccountSid!,
    authToken: config.twilioAuthToken!,
    from: config.twilioFrom!,
    sendWaitMs: config.twilioSendWaitMs,
    statusCallbackUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/api/providers/twilio/status` : null,
  };
}

/** Turns a stored contact reference into a Twilio `To` address, or null when it must not be sent to. */
export function routableAddress(contactRef: string, from: string): string | null {
  const trimmed = contactRef.trim();
  const viaWhatsApp = from.startsWith("whatsapp:");
  let number: string | null = null;
  let channel: "sms" | "whatsapp" = viaWhatsApp ? "whatsapp" : "sms";
  if (trimmed.startsWith("whatsapp:")) {
    number = trimmed.slice("whatsapp:".length);
    channel = "whatsapp";
  } else if (trimmed.startsWith("sms:")) {
    number = trimmed.slice("sms:".length);
    channel = "sms";
  } else if (trimmed.startsWith("+")) {
    number = trimmed;
  }
  if (!number || !E164.test(number)) return null;
  // The sender decides the channel: a WhatsApp sender cannot deliver SMS and vice versa.
  if (channel !== (viaWhatsApp ? "whatsapp" : "sms")) return null;
  return channel === "whatsapp" ? `whatsapp:${number}` : number;
}

/** Everything the UI or the audit trail might show, without the phone numbers. */
export function scrubTwilioPayload(payload: Record<string, unknown>): string {
  const { to: _to, from: _from, ...rest } = payload;
  return JSON.stringify({
    provider: "twilio",
    sid: rest.sid ?? null,
    status: rest.status ?? null,
    error_code: rest.error_code ?? null,
    error_message: rest.error_message ?? null,
    num_segments: rest.num_segments ?? null,
    date_updated: rest.date_updated ?? null,
  });
}

/**
 * Twilio signs webhooks with HMAC-SHA1 over the exact request URL plus the
 * POST parameters sorted by name, base64-encoded, keyed by the auth token.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export class TwilioDeliveryProvider implements DeliveryProvider {
  readonly name = "twilio";
  readonly live = true;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly settings: TwilioSettings) {
    this.fetchImpl = settings.fetchImpl ?? fetch;
    this.sleep = settings.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.settings.accountSid}:${this.settings.authToken}`).toString("base64")}`;
  }

  private messagesUrl(sid?: string): string {
    const base = `https://api.twilio.com/2010-04-01/Accounts/${this.settings.accountSid}/Messages`;
    return sid ? `${base}/${sid}.json` : `${base}.json`;
  }

  private async request(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: this.authHeader },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { parse_error: true };
      }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(request: SendRequest): Promise<SendResult> {
    const to = routableAddress(request.recipientRef, this.settings.from);
    if (!to) {
      return {
        outcome: "failed",
        reason: "contact_reference_not_routable",
        raw: JSON.stringify({ provider: "twilio", status: "refused", code: "contact_reference_not_routable" }),
      };
    }

    const form = new URLSearchParams({
      To: to,
      From: this.settings.from,
      Body: `${request.headline}\n\n${request.body}\n\n${request.cta}`,
    });
    if (this.settings.statusCallbackUrl) form.set("StatusCallback", this.settings.statusCallbackUrl);

    let created: { ok: boolean; status: number; body: Record<string, unknown> };
    try {
      created = await this.request(this.messagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (error) {
      // The request may or may not have reached Twilio. Nothing is known, so
      // the worker treats this like a timeout and checks status before retrying.
      log("warn", "twilio.send_unreachable", { reason: error instanceof Error ? error.name : "unknown" });
      return { outcome: "timeout", raw: JSON.stringify({ provider: "twilio", status: "unreachable" }), providerMessageId: null };
    }

    const sid = typeof created.body.sid === "string" ? created.body.sid : null;
    if (!created.ok || !sid) {
      const code = created.body.code ?? created.status;
      log("warn", "twilio.send_rejected", { http_status: created.status, code });
      return {
        outcome: "failed",
        reason: `twilio_${code}`,
        raw: scrubTwilioPayload({ ...created.body, status: "rejected", error_code: code }),
      };
    }

    // Twilio accepts asynchronously; wait a short while for a terminal state so
    // the demo shows "delivered" when it really is. Otherwise report a timeout
    // with the SID so the retry pass asks for status instead of sending again.
    const deadline = Date.now() + this.settings.sendWaitMs;
    let latest = created.body;
    while (Date.now() < deadline) {
      const status = String(latest.status ?? "");
      if (TERMINAL_DELIVERED.has(status)) {
        return { outcome: "delivered", providerMessageId: sid, raw: scrubTwilioPayload(latest) };
      }
      if (TERMINAL_FAILED.has(status)) {
        return { outcome: "failed", reason: `twilio_${latest.error_code ?? status}`, raw: scrubTwilioPayload(latest) };
      }
      await this.sleep(1500);
      try {
        latest = (await this.request(this.messagesUrl(sid), { method: "GET" })).body;
      } catch {
        break;
      }
    }
    const status = String(latest.status ?? "");
    if (TERMINAL_DELIVERED.has(status)) return { outcome: "delivered", providerMessageId: sid, raw: scrubTwilioPayload(latest) };
    if (TERMINAL_FAILED.has(status)) return { outcome: "failed", reason: `twilio_${latest.error_code ?? status}`, raw: scrubTwilioPayload(latest) };
    return { outcome: "timeout", raw: scrubTwilioPayload(latest), providerMessageId: sid };
  }

  async getStatus(_providerKey: string, hint: StatusHint = {}): Promise<StatusResult> {
    const sid = hint.providerMessageId;
    if (!sid) {
      return { state: "unavailable", raw: JSON.stringify({ provider: "twilio", status: "unavailable", reason: "no_message_sid" }) };
    }
    let result: { ok: boolean; status: number; body: Record<string, unknown> };
    try {
      result = await this.request(this.messagesUrl(sid), { method: "GET" });
    } catch {
      return { state: "unavailable", raw: JSON.stringify({ provider: "twilio", status: "unavailable", reason: "unreachable" }) };
    }
    if (!result.ok) {
      return { state: "unavailable", raw: scrubTwilioPayload({ ...result.body, status: "lookup_failed" }) };
    }
    const status = String(result.body.status ?? "");
    if (TERMINAL_DELIVERED.has(status)) return { state: "delivered", providerMessageId: sid, raw: scrubTwilioPayload(result.body) };
    if (TERMINAL_FAILED.has(status)) return { state: "not_delivered", raw: scrubTwilioPayload(result.body) };
    // queued / sending / sent: the carrier still has it. Not proof either way.
    return { state: "unavailable", raw: scrubTwilioPayload(result.body) };
  }
}
