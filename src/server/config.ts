import { loadEnvFiles } from "./env";
import { AppError } from "./errors";

loadEnvFiles();

export type AppConfig = {
  /** Pooled Neon connection for application traffic. Throws if unset. */
  readonly databaseUrl: string;
  /** Direct (unpooled) connection for migrations and schema administration. */
  readonly migrationDatabaseUrl: string;
  readonly hasDatabaseUrl: boolean;
  demoMode: boolean;
  geminiApiKey: string | null;
  geminiModel: string;
  /** "mock" (default) or "twilio". Anything else is refused at startup. */
  deliveryProvider: "mock" | "twilio";
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  /** E.164 number or `whatsapp:+E164`; the sender Twilio shows the customer. */
  twilioFrom: string | null;
  /** How long a send waits for a terminal Twilio status before reporting a timeout. */
  twilioSendWaitMs: number;
  /** Public origin of this deployment, used to sign and verify provider webhooks. */
  publicBaseUrl: string | null;
  /** Neon Auth. Identity, sessions and merchant data all stay on Neon. */
  neonAuthBaseUrl: string | null;
  neonAuthCookieSecret: string | null;
  /** Shared secret for Paytm-facing canonical REST/webhook ingestion. */
  connectorApiKey: string | null;
  /** n8n: where domain events are posted, and the shared secret both directions are signed with. */
  n8nWebhookUrl: string | null;
  n8nSecret: string | null;
  /** Cognee memory service (optional). Merchant memory always lives in Neon; Cognee mirrors it when configured. */
  cogneeBaseUrl: string | null;
  cogneeApiKey: string | null;
  maxImportBytes: number;
  maxImportRows: number;
  policyVersion: string;
};

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(): AppConfig {
  return {
    // Resolved lazily so `next build` and the health endpoint do not crash when
    // the database is not configured; the first real query fails with a clear error.
    get databaseUrl(): string {
      const url = nonEmpty(process.env.DATABASE_URL);
      if (!url) {
        throw new AppError(
          "UNAVAILABLE",
          "DATABASE_URL is not set. Copy .env.example to .env and paste the pooled Neon connection string.",
        );
      }
      return url;
    },
    get migrationDatabaseUrl(): string {
      return nonEmpty(process.env.DATABASE_URL_UNPOOLED) ?? this.databaseUrl;
    },
    get hasDatabaseUrl(): boolean {
      return nonEmpty(process.env.DATABASE_URL) !== null;
    },
    demoMode: readBool(process.env.SAATHI_DEMO_MODE, false),
    geminiApiKey: nonEmpty(process.env.GEMINI_API_KEY),
    geminiModel: process.env.SAATHI_GEMINI_MODEL ?? "gemini-2.5-flash",
    deliveryProvider: process.env.SAATHI_DELIVERY_PROVIDER?.trim().toLowerCase() === "twilio" ? "twilio" : "mock",
    twilioAccountSid: nonEmpty(process.env.TWILIO_ACCOUNT_SID),
    twilioAuthToken: nonEmpty(process.env.TWILIO_AUTH_TOKEN),
    twilioFrom: nonEmpty(process.env.TWILIO_FROM),
    twilioSendWaitMs: Number.parseInt(process.env.TWILIO_SEND_WAIT_MS ?? "8000", 10) || 8000,
    publicBaseUrl: nonEmpty(process.env.PUBLIC_BASE_URL)?.replace(/\/+$/, "") ?? null,
    neonAuthBaseUrl: nonEmpty(process.env.NEON_AUTH_BASE_URL)?.replace(/\/+$/, "") ?? null,
    neonAuthCookieSecret: nonEmpty(process.env.NEON_AUTH_COOKIE_SECRET),
    connectorApiKey: nonEmpty(process.env.SAATHI_CONNECTOR_API_KEY),
    n8nWebhookUrl: nonEmpty(process.env.N8N_WEBHOOK_URL),
    n8nSecret: nonEmpty(process.env.N8N_WEBHOOK_SECRET),
    cogneeBaseUrl: nonEmpty(process.env.COGNEE_BASE_URL)?.replace(/\/+$/, "") ?? null,
    cogneeApiKey: nonEmpty(process.env.COGNEE_API_KEY),
    maxImportBytes: 2 * 1024 * 1024,
    maxImportRows: 20000,
    policyVersion: "retention-v1",
  };
}

export const config = loadConfig();

/** Host portion of a connection string, for logs and health output. Never the credentials. */
export function describeDatabaseTarget(url: string): { host: string; database: string; pooled: boolean } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, ""),
      pooled: parsed.hostname.includes("-pooler"),
    };
  } catch {
    return { host: "unparseable", database: "unknown", pooled: false };
  }
}
