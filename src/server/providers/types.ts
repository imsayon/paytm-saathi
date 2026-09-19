export type SendRequest = {
  providerKey: string;
  recipientRef: string;
  headline: string;
  body: string;
  cta: string;
  scenarioSlot: number;
};

export type SendResult =
  | { outcome: "delivered"; providerMessageId: string; raw: string }
  | { outcome: "failed"; reason: string; raw: string }
  | { outcome: "timeout"; raw: string; providerMessageId?: string | null };

export type StatusResult =
  | { state: "delivered"; providerMessageId: string; raw: string }
  | { state: "not_delivered"; raw: string }
  | { state: "unavailable"; raw: string };

/** What the worker already knows about earlier attempts, so a status lookup can find the message. */
export type StatusHint = {
  providerMessageId?: string | null;
};

export interface DeliveryProvider {
  readonly name: string;
  /** True when a send reaches a real person. The health endpoint and the UI report it. */
  readonly live: boolean;
  send(request: SendRequest): Promise<SendResult>;
  getStatus(providerKey: string, hint?: StatusHint): Promise<StatusResult>;
}
