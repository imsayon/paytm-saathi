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
  openAiApiKey: string | null;
  openAiModel: string;
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
    demoMode: readBool(process.env.SAATHI_DEMO_MODE, true),
    openAiApiKey: nonEmpty(process.env.OPENAI_API_KEY),
    openAiModel: process.env.SAATHI_OPENAI_MODEL ?? "gpt-5-mini",
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
