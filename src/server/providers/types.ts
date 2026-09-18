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
  | { outcome: "timeout"; raw: string };

export type StatusResult =
  | { state: "delivered"; providerMessageId: string; raw: string }
  | { state: "not_delivered"; raw: string }
  | { state: "unavailable"; raw: string };

export interface DeliveryProvider {
  readonly name: string;
  send(request: SendRequest): Promise<SendResult>;
  getStatus(providerKey: string): Promise<StatusResult>;
}
