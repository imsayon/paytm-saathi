import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBatchSchema, connectorSignature } from "../../src/server/connectors/canonical";

test("canonical Paytm-shaped batches validate without exposing customer IDs to the planner", () => {
  const batch = canonicalBatchSchema.parse({
    source: "paytm-webhook",
    merchant_ref: "mch_demo_bengaluru",
    payments: [{
      source_event_id: "pay_001",
      customer_ref: "cust_001",
      occurred_at: "2026-08-01T10:30:00+05:30",
      amount_minor: 25000,
      currency: "INR",
      status: "settled",
    }],
    consents: [{
      source_event_id: "consent_001",
      customer_ref: "cust_001",
      purpose: "merchant_reengagement",
      channel: "sms",
      state: "granted",
      captured_at: "2026-08-01T10:30:00+05:30",
    }],
  });

  assert.equal(batch.payments[0]?.currency, "INR");
  assert.equal(batch.consents[0]?.purpose, "merchant_reengagement");
  assert.equal("contact_ref" in batch.consents[0]!, false);
});

test("connector signatures are stable and change when the raw body changes", () => {
  const signature = connectorSignature("secret", "1770000000", '{"ok":true}');
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.notEqual(signature, connectorSignature("secret", "1770000000", '{"ok":false}'));
});
