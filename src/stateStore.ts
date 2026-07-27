import { Pool } from "pg";

interface PollStateRow {
  readonly fingerprints: readonly string[];
  readonly auth_alert_sent: boolean;
}

export interface PollState {
  readonly fingerprints: ReadonlySet<string>;
  readonly hasPolledBefore: boolean;
  readonly authAlertSent: boolean;
}

let pool: Pool | undefined;

/**
 * Returns a shared connection pool for databaseUrl, creating it (and the poll_state
 * table, if missing) on first use. Reused across calls within one process so repeated
 * loadState/saveState calls (e.g. the in-process poll loop) don't reopen connections.
 */
async function getPool(databaseUrl: string): Promise<Pool> {
  if (pool) {
    return pool;
  }
  pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_state (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      fingerprints TEXT[] NOT NULL DEFAULT '{}',
      auth_alert_sent BOOLEAN NOT NULL DEFAULT false
    )
  `);
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

/**
 * Reads the persisted poll state from the poll_state table (single row, id = 1).
 * Returns { fingerprints, authAlertSent, hasPolledBefore: true } if that row already
 * exists (even with zero fingerprints, meaning a prior poll found no showtimes), or a
 * zeroed-out state with hasPolledBefore: false if this is the very first poll ever
 * (whether that's the first-ever run of a long-lived process, or the first-ever
 * GitHub Actions invocation).
 */
export async function loadState(databaseUrl: string): Promise<PollState> {
  const db = await getPool(databaseUrl);
  const result = await db.query<PollStateRow>(
    "SELECT fingerprints, auth_alert_sent FROM poll_state WHERE id = 1",
  );

  const row = result.rows[0];
  if (!row) {
    return { fingerprints: new Set(), hasPolledBefore: false, authAlertSent: false };
  }

  return {
    fingerprints: new Set(row.fingerprints),
    hasPolledBefore: true,
    authAlertSent: row.auth_alert_sent,
  };
}

/**
 * Upserts the given poll state into the poll_state table (single row, id = 1).
 * Returns nothing; this becomes the new baseline for the next poll (whether the next
 * loop iteration in-process, or the next GitHub Actions run).
 */
export async function saveState(databaseUrl: string, state: PollState): Promise<void> {
  const db = await getPool(databaseUrl);
  await db.query(
    `INSERT INTO poll_state (id, fingerprints, auth_alert_sent)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET fingerprints = $1, auth_alert_sent = $2`,
    [[...state.fingerprints], state.authAlertSent],
  );
}
