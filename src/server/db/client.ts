import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config";
import { SCHEMA_SQL } from "./schema";

export type Db = Database.Database;

let cached: Db | null = null;

export function openDatabase(dbPath: string = config.dbPath): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

export function getDb(): Db {
  if (!cached) cached = openDatabase();
  return cached;
}

/**
 * BEGIN IMMEDIATE takes the write lock up front, so two concurrent approvals
 * cannot both read "not yet approved" and then both queue jobs.
 */
export function inWriteTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
