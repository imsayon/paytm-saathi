import assert from "node:assert/strict";
import { test } from "node:test";
import {
  routableAddress,
  scrubTwilioPayload,
  TwilioDeliveryProvider,
  twilioSignature,
  validTwilioSignature,
  type TwilioSettings,
} from "../../src/server/providers/twilio";

type Reply = { status?: number; body: Record<string, unknown> };

/** A fake Twilio: records requests, answers from a script, never touches the network. */
function fakeTwilio(replies: Reply[], from = "whatsapp:+14155238886") {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const reply = replies.shift() ?? { status: 500, body: { message: "script exhausted" } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const settings: TwilioSettings = {
    accountSid: "ACtest",
    authToken: "token",
    from,
    sendWaitMs: 100,
    statusCallbackUrl: "https://example.test/api/providers/twilio/status",
    fetchImpl,
    sleep: async () => {},
  };
  return { provider: new TwilioDeliveryProvider(settings), calls };
}

const request = {
  providerKey: "mock_abc",
  recipientRef: "whatsapp:+919876543210",
  headline: "A welcome back reward",
  body: "We would love to welcome you back. Get ₹15.00 off one order on a weekday. Valid for 7 days.",
  cta: "Visit us",
  scenarioSlot: 0,
};

test("only E.164 references on the sender's channel are routable; the synthetic fixture never is", () => {
  const wa = "whatsapp:+14155238886";
  assert.equal(routableAddress("whatsapp:+919876543210", wa), "whatsapp:+919876543210");
  assert.equal(routableAddress("+919876543210", wa), "whatsapp:+919876543210");
  assert.equal(routableAddress("sms:+919876543210", wa), null, "an SMS-only reference cannot go through a WhatsApp sender");
  assert.equal(routableAddress("+919876543210", "+12025550123"), "+919876543210");
  assert.equal(routableAddress("synthetic-sms:+91-5550-1000", wa), null);
  assert.equal(routableAddress("synthetic-sms:+91-5550-1000", "+12025550123"), null);
  assert.equal(routableAddress("+91 98765 43210", wa), null, "spaces are not E.164");
});

test("a delivered message is reported delivered with its SID and without phone numbers in the stored payload", async () => {
  const { provider, calls } = fakeTwilio([
    { status: 201, body: { sid: "SM1", status: "queued", to: "whatsapp:+919876543210", from: "whatsapp:+1415" } },
    { body: { sid: "SM1", status: "sent", to: "whatsapp:+919876543210" } },
    { body: { sid: "SM1", status: "delivered", to: "whatsapp:+919876543210", num_segments: "1" } },
  ]);
  const result = await provider.send(request);
  assert.equal(result.outcome, "delivered");
  assert.equal(result.outcome === "delivered" && result.providerMessageId, "SM1");
  assert.ok(!result.raw.includes("9876543210"), "raw payload must not carry the recipient");
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.body ?? "", /To=whatsapp%3A%2B919876543210/);
  assert.match(calls[0]!.body ?? "", /StatusCallback=/);
  assert.ok(!calls.some((c) => c.url.includes("9876543210")), "the recipient never appears in a URL");
});

test("a terminal Twilio failure is a failed attempt with the error code as the reason", async () => {
  const { provider } = fakeTwilio([
    { status: 201, body: { sid: "SM2", status: "queued" } },
    { body: { sid: "SM2", status: "undelivered", error_code: 30003 } },
  ]);
  const result = await provider.send(request);
  assert.equal(result.outcome, "failed");
  assert.equal(result.outcome === "failed" && result.reason, "twilio_30003");
});

test("a rejected create (trial restrictions, bad number) fails without a retry", async () => {
  const { provider } = fakeTwilio([{ status: 400, body: { code: 21608, message: "unverified number" } }]);
  const result = await provider.send(request);
  assert.equal(result.outcome, "failed");
  assert.equal(result.outcome === "failed" && result.reason, "twilio_21608");
});

test("a message still with the carrier after the wait is a timeout that carries the SID", async () => {
  const { provider } = fakeTwilio([
    { status: 201, body: { sid: "SM3", status: "queued" } },
    { body: { sid: "SM3", status: "sending" } },
    { body: { sid: "SM3", status: "sent" } },
    { body: { sid: "SM3", status: "sent" } },
  ]);
  const result = await provider.send(request);
  assert.equal(result.outcome, "timeout");
  assert.equal(result.outcome === "timeout" && result.providerMessageId, "SM3");
});

test("status lookup needs the SID: delivered, not delivered, or honestly unavailable", async () => {
  const { provider } = fakeTwilio([
    { body: { sid: "SM4", status: "delivered" } },
    { body: { sid: "SM4", status: "failed" } },
    { body: { sid: "SM4", status: "sent" } },
  ]);
  assert.equal((await provider.getStatus("k", { providerMessageId: "SM4" })).state, "delivered");
  assert.equal((await provider.getStatus("k", { providerMessageId: "SM4" })).state, "not_delivered");
  assert.equal((await provider.getStatus("k", { providerMessageId: "SM4" })).state, "unavailable", "in flight is not proof either way");
  assert.equal((await provider.getStatus("k", {})).state, "unavailable", "no SID means nothing safe to look up");
});

test("a network failure during send is a timeout, so the worker checks status before any retry", async () => {
  const settings: TwilioSettings = {
    accountSid: "ACtest",
    authToken: "token",
    from: "whatsapp:+14155238886",
    sendWaitMs: 100,
    statusCallbackUrl: null,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    sleep: async () => {},
  };
  const result = await new TwilioDeliveryProvider(settings).send(request);
  assert.equal(result.outcome, "timeout");
});

test("webhook signatures follow Twilio's scheme and are compared in constant time", () => {
  const url = "https://example.test/api/providers/twilio/status";
  const params = { MessageSid: "SM9", MessageStatus: "delivered", To: "whatsapp:+919876543210" };
  const signature = twilioSignature("token", url, params);
  assert.equal(validTwilioSignature("token", url, params, signature), true);
  assert.equal(validTwilioSignature("token", url, { ...params, MessageStatus: "failed" }, signature), false);
  assert.equal(validTwilioSignature("other", url, params, signature), false);
  assert.equal(validTwilioSignature("token", url, params, null), false);
});

test("scrubbed payloads keep status and error, never the numbers", () => {
  const raw = scrubTwilioPayload({ sid: "SM1", status: "delivered", to: "+919876543210", from: "+1415", error_code: null });
  assert.ok(!raw.includes("+91"));
  assert.match(raw, /"sid":"SM1"/);
  assert.match(raw, /"status":"delivered"/);
});
