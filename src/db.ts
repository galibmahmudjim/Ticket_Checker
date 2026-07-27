import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * Returns a shared connection pool for databaseUrl, creating it on first use. Shared
 * across stateStore.ts and recipientStore.ts so the process doesn't open multiple
 * pools to the same database.
 */
export function getPool(databaseUrl: string): Pool {
  pool ??= new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
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
