import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./client";

export const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

export type MigrationOutcome = {
  applied: string[];
  alreadyApplied: string[];
};

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): { name: string; sql: string; checksum: string }[] {
  if (!fs.existsSync(dir)) throw new Error(`Migrations directory is missing: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    });
}

/**
 * Applies every migration file that is not yet recorded, each in its own
 * transaction, under an advisory lock so two migrators cannot race. A recorded
 * migration whose file has changed is an error, never a silent re-run.
 */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationOutcome> {
  const files = listMigrationFiles(dir);
  const outcome: MigrationOutcome = { applied: [], alreadyApplied: [] };

  await db.run(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  for (const file of files) {
    await db.transaction(async (tx) => {
      await tx.run(`SELECT pg_advisory_xact_lock(hashtext('saathi_schema_migration'))`);
      const existing = await tx.one<{ checksum: string }>(`SELECT checksum FROM schema_migration WHERE name = $1`, [
        file.name,
      ]);
      if (existing) {
        if (existing.checksum !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was already applied with a different checksum. Add a new migration instead of editing an applied one.`,
          );
        }
        outcome.alreadyApplied.push(file.name);
        return;
      }
      await tx.query(file.sql);
      await tx.run(`INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)`, [file.name, file.checksum]);
      outcome.applied.push(file.name);
    });
  }
  return outcome;
}

/** True when every migration file on disk is recorded as applied. */
export async function migrationsAreCurrent(db: Db, dir: string = MIGRATIONS_DIR): Promise<{ current: boolean; pending: string[] }> {
  const files = listMigrationFiles(dir);
  const table = await db.one<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migration' AND table_schema = ANY (current_schemas(false))) AS exists`,
  );
  if (!table?.exists) return { current: false, pending: files.map((file) => file.name) };
  const applied = new Set((await db.all<{ name: string }>(`SELECT name FROM schema_migration`)).map((row) => row.name));
  const pending = files.filter((file) => !applied.has(file.name)).map((file) => file.name);
  return { current: pending.length === 0, pending };
}
