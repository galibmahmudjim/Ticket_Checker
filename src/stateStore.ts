import type { Pool } from "pg";
import { getPool } from "./db.js";

interface PollStateRow {
  readonly fingerprints: readonly string[];
  readonly auth_alert_sent: boolean;
}

export interface PollState {
  readonly fingerprints: ReadonlySet<string>;
  readonly hasPolledBefore: boolean;
  readonly authAlertSent: boolean;
}

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the poll_state table exists first
 * (once per process — guarded so repeated loadState/saveState calls don't re-issue
 * the CREATE TABLE every time).
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS poll_state (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        fingerprints TEXT[] NOT NULL DEFAULT '{}',
        auth_alert_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Reads the persisted poll state from the poll_state table (single row, id = 1).
 * Returns { fingerprints, authAlertSent, hasPolledBefore: true } if that row already
 * exists (even with zero fingerprints, meaning a prior poll found no showtimes), or a
 * zeroed-out state with hasPolledBefore: false if this is the very first poll ever.
 */
export async function loadState(databaseUrl: string): Promise<PollState> {
  const db = await ensureTable(databaseUrl);
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
 * Returns nothing; this becomes the new baseline for the next poll.
 */
export async function saveState(databaseUrl: string, state: PollState): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    `INSERT INTO poll_state (id, fingerprints, auth_alert_sent)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET fingerprints = $1, auth_alert_sent = $2`,
    [[...state.fingerprints], state.authAlertSent],
  );
}
