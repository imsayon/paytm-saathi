import crypto from "node:crypto";
import type { DeliveryProvider, SendRequest, SendResult, StatusResult } from "./types";

/**
 * The only provider in this build. It never contacts a real person: it records
 * what a provider would have been asked to do and returns a deterministic result.
 *
 * Scenario slots keep the rehearsed demo honest about failure handling:
 *   slot 2 -> first attempt times out, status later proves nothing was delivered
 *   slot 5 -> terminal failure (unreachable contact reference)
 *   all others -> delivered on the first attempt
 */
const TIMEOUT_SLOT = 2;
const HARD_FAIL_SLOT = 5;

const timedOutKeys = new Set<string>();

export class MockDeliveryProvider implements DeliveryProvider {
  readonly name = "mock";
  readonly live = false;

  async send(request: SendRequest): Promise<SendResult> {
    if (request.scenarioSlot === HARD_FAIL_SLOT) {
      return {
        outcome: "failed",
        reason: "contact_reference_unreachable",
        raw: JSON.stringify({ provider: "mock", status: "failed", code: "unreachable" }),
      };
    }

    if (request.scenarioSlot === TIMEOUT_SLOT && !timedOutKeys.has(request.providerKey)) {
      timedOutKeys.add(request.providerKey);
      return {
        outcome: "timeout",
        raw: JSON.stringify({ provider: "mock", status: "timeout", code: "gateway_timeout" }),
      };
    }

    const providerMessageId = `mockmsg_${crypto
      .createHash("sha256")
      .update(request.providerKey)
      .digest("hex")
      .slice(0, 16)}`;

    return {
      outcome: "delivered",
      providerMessageId,
      raw: JSON.stringify({ provider: "mock", status: "delivered", message_id: providerMessageId }),
    };
  }

  async getStatus(providerKey: string): Promise<StatusResult> {
    if (timedOutKeys.has(providerKey)) {
      return {
        state: "not_delivered",
        raw: JSON.stringify({ provider: "mock", status: "not_found", provider_key: providerKey }),
      };
    }
    return {
      state: "unavailable",
      raw: JSON.stringify({ provider: "mock", status: "unavailable", provider_key: providerKey }),
    };
  }
}

export const mockProvider = new MockDeliveryProvider();

/** Test seam: forget remembered timeouts between runs. */
export function resetMockProviderState(): void {
  timedOutKeys.clear();
}
