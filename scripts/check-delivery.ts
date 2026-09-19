import { loadEnvFiles } from "../src/server/env";

loadEnvFiles();

// Sends exactly one message through the configured provider to TWILIO_TEST_TO.
// No database, no customers, no jobs: a plumbing check for the sender, the
// credentials and the recipient's channel, with the same code path the worker
// uses. Refuses to run against the mock so it cannot be mistaken for a pass.
const { config } = await import("../src/server/config");
const { getDeliveryProvider } = await import("../src/server/providers");

const to = process.env.TWILIO_TEST_TO?.trim();
if (config.deliveryProvider !== "twilio") {
  console.error("SAATHI_DELIVERY_PROVIDER is not twilio; nothing to check.");
  process.exit(1);
}
if (!to) {
  console.error("Set TWILIO_TEST_TO (a number verified on the Twilio account, e.g. whatsapp:+91XXXXXXXXXX).");
  process.exit(1);
}

const provider = getDeliveryProvider();
const result = await provider.send({
  providerKey: `check_${Date.now()}`,
  recipientRef: to,
  headline: "Paytm Saathi delivery check",
  body: "This is a one-off test from the Saathi worker path. No offer, no campaign.",
  cta: "Reply STOP to opt out",
  scenarioSlot: 0,
});
console.log(JSON.stringify({ provider: provider.name, live: provider.live, outcome: result.outcome, ...("reason" in result ? { reason: result.reason } : {}), raw: JSON.parse(result.raw) }));
process.exit(result.outcome === "delivered" ? 0 : result.outcome === "timeout" ? 2 : 1);
