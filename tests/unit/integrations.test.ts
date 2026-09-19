import assert from "node:assert/strict";
import { test } from "node:test";
import { signBody, verifySignature } from "../../src/server/integrations/events";

test("n8n event signatures accept the exact body and reject tampering", () => {
  const body = JSON.stringify({ event: "report.generated", payload: { campaign_count: 1 } });
  const signature = signBody("test-secret", body);

  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.equal(verifySignature("test-secret", body, signature), true);
  assert.equal(verifySignature("wrong-secret", body, signature), false);
  assert.equal(verifySignature("test-secret", `${body} `, signature), false);
  assert.equal(verifySignature("test-secret", body, null), false);
});
