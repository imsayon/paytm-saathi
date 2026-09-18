import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env.local` then `.env` from the repository root into process.env,
 * without overriding variables that are already set. Next.js does this on its
 * own; this exists so the migration script, seed script, worker and tests see
 * the same configuration without a dotenv dependency. Values are never logged.
 */
export function loadEnvFiles(root: string = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}
