import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { config } from "../config";
import { log } from "../observability/log";

// Column types come back as the shapes the domain code works with: dates as
// YYYY-MM-DD strings, timestamps as ISO strings, counts as numbers. JSONB is
// parsed by the driver.
const TIMESTAMPTZ_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::?(\d{2}))?$/;

/** Postgres timestamptz text ("2026-09-18 16:58:16.32+00") to an ISO-8601 UTC string. */
export function timestamptzToIso(value: string): string {
  const match = TIMESTAMPTZ_TEXT.exec(value);
  if (!match) return new Date(value).toISOString();
  const millis = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  return new Date(`${match[1]}T${match[2]}.${millis}${match[4]}:${match[5] ?? "00"}`).toISOString();
}

pg.types.setTypeParser(1184, timestamptzToIso);
pg.types.setTypeParser(1082, (value: string) => value);
pg.types.setTypeParser(20, (value: string) => Number(value));

type Source = Pool | PoolClient;

/**
 * Thin handle over a pg Pool (autocommit) or a checked-out client inside a
 * transaction. Domain code takes a Db so the same function works in both.
 */
export class Db {
  // A transaction owns one connection, so concurrent callers (Promise.all in
  // domain code) are serialized here instead of racing on the client.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly source: Source,
    readonly inTransaction: boolean = false,
  ) {}

  query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    if (!this.inTransaction) return retryOnConnectTimeout(() => this.source.query<R>(text, values));
    const result = this.queue.then(() => this.source.query<R>(text, values));
    this.queue = result.catch(() => undefined);
    return result;
  }

  async all<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    return (await this.query<R>(text, values)).rows;
  }

  async one<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<R | undefined> {
    return (await this.query<R>(text, values)).rows[0];
  }

  /** Runs a statement and returns the affected row count. */
  async run(text: string, values: unknown[] = []): Promise<number> {
    return (await this.query(text, values)).rowCount ?? 0;
  }

  /**
   * Runs `fn` inside one transaction. Everything inside must use the `tx`
   * handle, never the outer pool, or it would run outside the transaction.
   * Nested calls join the enclosing transaction.
   */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const client = await retryOnConnectTimeout(() => (this.source as Pool).connect());
    const tx = new Db(client, true);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Multi-row insert in chunks that stay under Postgres' parameter limit.
   * Returns the number of rows the database reports as inserted, so callers can
   * see how many an ON CONFLICT clause skipped.
   */
  async insertMany(
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
    suffix = "",
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const chunkSize = Math.max(1, Math.floor(60_000 / columns.length));
    let inserted = 0;
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const values: unknown[] = [];
      const tuples = chunk.map((row) => {
        const placeholders = row.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      inserted += await this.run(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} ${suffix}`,
        values,
      );
    }
    return inserted;
  }
}

export type PoolOptions = {
  /** Postgres schema to put first on the search path. Direct connections only. */
  schema?: string;
  max?: number;
  /** Clients the pool keeps open instead of closing them when idle. */
  min?: number;
};

const CONNECT_PHASE_ERROR = /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;

/** True only for failures raised before any statement reached the server. */
export function isConnectPhaseError(error: unknown): boolean {
  return error instanceof Error && CONNECT_PHASE_ERROR.test(error.message);
}

/**
 * Re-runs `attempt` when establishing a connection timed out. Nothing has been
 * sent to the server at that point, so retrying cannot double-execute a
 * statement; any other error is rethrown untouched.
 */
export async function retryOnConnectTimeout<T>(attempt: () => Promise<T>, retries = 2): Promise<T> {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tried >= retries || !isConnectPhaseError(error)) throw error;
      log("warn", "db.connect_retry", { attempt: tried + 1 });
      await new Promise((resolve) => setTimeout(resolve, 250 * (tried + 1)));
    }
  }
}

export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  const local = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 8,
    min: options.min ?? 0,
    // A drained pool that reopens eight TLS connections at once has stalled
    // on flaky Wi-Fi; a long idle timeout keeps warm clients around between
    // demo steps, and a short connect timeout lets the retry above kick in.
    idleTimeoutMillis: 120_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Neon requires TLS with certificate verification; a URL without sslmode
    // must not silently connect in plaintext.
    ssl: local ? undefined : { rejectUnauthorized: true },
    // The schema is a startup parameter, so it is in place before the first
    // query and needs no session-level SET. Direct connections only.
    ...(options.schema ? { options: `-c search_path=${quoteIdent(options.schema)},public` } : {}),
  });
  pool.on("error", () => {
    // An idle client dropped by the server; the pool replaces it on next use.
  });
  return pool;
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

type Cache = { pool: Pool; db: Db; url: string; heartbeat: NodeJS.Timeout } | null;
const globalCache = globalThis as unknown as { __saathiDb?: Cache };

const HEARTBEAT_MS = 25_000;

/** Application handle on the pooled Neon connection. Cached across hot reloads. */
export function getDb(): Db {
  const url = config.databaseUrl;
  const cached = globalCache.__saathiDb;
  if (cached && cached.url === url) return cached.db;
  const pool = createPool(url, { min: 2 });
  const db = new Db(pool);
  // While the app runs, a cheap query every 25 s keeps two clients warm and
  // stops Neon's scale-to-zero, so the first click after a pause on stage does
  // not wait for a compute wake-up plus a burst of new TLS handshakes.
  // `unref` lets scripts exit without an explicit closeDb().
  const heartbeat = setInterval(() => {
    pool.query("SELECT 1").catch(() => {
      // The next real query reconnects and reports the problem itself.
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  globalCache.__saathiDb = { pool, db, url, heartbeat };
  return db;
}

export async function closeDb(): Promise<void> {
  const cached = globalCache.__saathiDb;
  globalCache.__saathiDb = null;
  if (cached) {
    clearInterval(cached.heartbeat);
    await cached.pool.end();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
