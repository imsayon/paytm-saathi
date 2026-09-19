import { config } from "../config";
import { mockProvider } from "./mock";
import { TwilioDeliveryProvider, twilioSettingsFromEnv } from "./twilio";
import type { DeliveryProvider } from "./types";

let cached: DeliveryProvider | null = null;

/**
 * The one place that decides which provider the worker and the demo control
 * use. Mock unless SAATHI_DELIVERY_PROVIDER=twilio, and Twilio refuses to
 * start with any of its settings missing rather than silently sending nothing.
 */
export function getDeliveryProvider(): DeliveryProvider {
  if (cached) return cached;
  cached = config.deliveryProvider === "twilio" ? new TwilioDeliveryProvider(twilioSettingsFromEnv()) : mockProvider;
  return cached;
}

export function describeDeliveryProvider(): { name: string; live: boolean } {
  if (config.deliveryProvider === "twilio") return { name: "twilio", live: true };
  return { name: mockProvider.name, live: mockProvider.live };
}
