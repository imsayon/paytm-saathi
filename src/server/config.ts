import path from "node:path";

export type AppConfig = {
  dbPath: string;
  demoMode: boolean;
  openAiApiKey: string | null;
  openAiModel: string;
  maxImportBytes: number;
  maxImportRows: number;
  policyVersion: string;
};

const REPO_ROOT = process.cwd();

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export function loadConfig(): AppConfig {
  const dbPath = process.env.SAATHI_DB_PATH ?? "./data/saathi.db";
  return {
    dbPath: path.isAbsolute(dbPath) ? dbPath : path.join(REPO_ROOT, dbPath),
    demoMode: readBool(process.env.SAATHI_DEMO_MODE, true),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() ? process.env.OPENAI_API_KEY.trim() : null,
    openAiModel: process.env.SAATHI_OPENAI_MODEL ?? "gpt-4o-mini",
    maxImportBytes: 2 * 1024 * 1024,
    maxImportRows: 20000,
    policyVersion: "retention-v1",
  };
}

export const config = loadConfig();
