import { Pool } from "pg";

let pool: Pool | undefined;

const MAX_CONNECTIONS_PER_INSTANCE = 2;

/**
 * Returns a shared connection pool for databaseUrl, creating it on first use and
 * reusing it across warm invocations. Shared by stateStore.ts, channelStore.ts and
 * chainLease.ts so one process never opens multiple pools to the same database.
 *
 * The pool is capped at two connections because on Vercel every concurrently warm
 * function instance holds its own pool: an uncapped default would multiply across
 * instances and exhaust the database's connection limit. DATABASE_URL should point at
 * a pooled endpoint (Neon's pooler or Supabase's pgbouncer port) for the same reason.
 * Idle connections are reaped quickly since a frozen instance keeps them open
 * otherwise.
 */
export function getPool(databaseUrl: string): Pool {
  pool ??= new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: MAX_CONNECTIONS_PER_INSTANCE,
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

/**
 * Closes the shared connection pool, if one was opened. Returns nothing; used by
 * index.ts on graceful shutdown so an open pool doesn't keep the process alive.
 */
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
