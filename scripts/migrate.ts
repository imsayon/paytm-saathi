import { config } from "../src/server/config";
import { openDatabase } from "../src/server/db/client";

const db = openDatabase();
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all() as { name: string }[];

console.log(
  JSON.stringify({ database: config.dbPath, tables: tables.map((table) => table.name) }, null, 2),
);
db.close();
