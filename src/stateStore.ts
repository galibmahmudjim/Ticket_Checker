import type { Pool } from "pg";
import { getPool } from "./db.js";

export type PollStatus = "ok" | "auth-error" | "error";

export interface PollState {
  readonly authAlertSent: boolean;
  readonly lastPolledAt: Date | null;
  readonly lastPollStatus: PollStatus | null;
  readonly lastSessionCount: number | null;
}

interface PollStateRow {
  readonly auth_alert_sent: boolean;
  readonly last_polled_at: Date | null;
  readonly last_poll_status: PollStatus | null;
  readonly last_session_count: number | null;
}

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the poll_state table exists and carries
 * the liveness columns (once per process). The ALTER statements run separately from
 * CREATE TABLE because `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already
 * exists, so it would never add columns to a database created before they existed.
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS poll_state (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        auth_alert_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await db.query(`
      ALTER TABLE poll_state
        ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_poll_status TEXT,
        ADD COLUMN IF NOT EXISTS last_session_count INTEGER
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Reads the persisted global poll state (single row, id = 1): the one-time auth-alert
 * flag plus when the last poll ran, whether it succeeded, and how many sessions it
 * saw. Per-channel fingerprint tracking lives in channelStore.ts instead, since that
 * has to be independent per channel. Returns an all-null state if no row exists yet.
 */
export async function loadState(databaseUrl: string): Promise<PollState> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<PollStateRow>(
    "SELECT auth_alert_sent, last_polled_at, last_poll_status, last_session_count FROM poll_state WHERE id = 1",
  );
  const row = result.rows[0];
  return {
    authAlertSent: row?.auth_alert_sent ?? false,
    lastPolledAt: row?.last_polled_at ?? null,
    lastPollStatus: row?.last_poll_status ?? null,
    lastSessionCount: row?.last_session_count ?? null,
  };
}

/**
 * Upserts the given global poll state into the poll_state table (single row, id = 1).
 * Returns nothing; this becomes the new baseline for the next poll, and the record
 * `/api/status` reports so a bot left running unattended can be checked without
 * reading logs.
 */
export async function saveState(databaseUrl: string, state: PollState): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    `INSERT INTO poll_state (id, auth_alert_sent, last_polled_at, last_poll_status, last_session_count)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       auth_alert_sent = $1,
       last_polled_at = $2,
       last_poll_status = $3,
       last_session_count = $4`,
    [state.authAlertSent, state.lastPolledAt, state.lastPollStatus, state.lastSessionCount],
  );
}
