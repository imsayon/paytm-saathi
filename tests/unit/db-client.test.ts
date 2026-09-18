import assert from "node:assert/strict";
import { test } from "node:test";
import { isConnectPhaseError, retryOnConnectTimeout, timestamptzToIso } from "../../src/server/db/client";

test("only connect-phase timeouts are classified as safely retryable", () => {
  assert.equal(isConnectPhaseError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isConnectPhaseError(new Error("Connection terminated due to connection timeout")), true);
  assert.equal(isConnectPhaseError(new Error("Connection terminated unexpectedly")), false, "may have executed");
  assert.equal(isConnectPhaseError(new Error("duplicate key value violates unique constraint")), false);
  assert.equal(isConnectPhaseError("timeout exceeded when trying to connect"), false, "not an Error instance");
});

test("a connect timeout is retried and the first successful attempt wins", async () => {
  let calls = 0;
  const value = await retryOnConnectTimeout(async () => {
    calls += 1;
    if (calls < 3) throw new Error("timeout exceeded when trying to connect");
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("retries stop after the configured budget and other errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnConnectTimeout(async () => {
      calls += 1;
      throw new Error("Connection terminated due to connection timeout");
    }, 1),
    /connection timeout/,
  );
  assert.equal(calls, 2, "one attempt plus one retry");

  calls = 0;
  await assert.rejects(
    retryOnConnectTimeout(async () => {
      calls += 1;
      throw new Error("relation \"missing\" does not exist");
    }),
    /does not exist/,
  );
  assert.equal(calls, 1, "a server error must never be re-run blindly");
});

test("timestamptz text converts to an ISO string regardless of fractional precision", () => {
  assert.equal(timestamptzToIso("2026-09-18 16:58:16.32+00"), "2026-09-18T16:58:16.320Z");
  assert.equal(timestamptzToIso("2026-09-18 16:58:16+05:30"), "2026-09-18T11:28:16.000Z");
  assert.equal(timestamptzToIso("2026-09-18 16:58:16.123456+00"), "2026-09-18T16:58:16.123Z");
});
