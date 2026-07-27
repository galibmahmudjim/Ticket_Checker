import type { Pool } from "pg";
import { getPool } from "./db.js";

export interface PollState {
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
        auth_alert_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Reads the persisted global poll state (single row, id = 1) — currently just the
 * one-time auth-alert flag; per-channel fingerprint/baseline tracking lives in
 * channelStore.ts instead, since that needs to be independent per channel. Returns
 * { authAlertSent: false } if no row exists yet.
 */
export async function loadState(databaseUrl: string): Promise<PollState> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ auth_alert_sent: boolean }>(
    "SELECT auth_alert_sent FROM poll_state WHERE id = 1",
  );
  return { authAlertSent: result.rows[0]?.auth_alert_sent ?? false };
}

/**
 * Upserts the given global poll state into the poll_state table (single row, id = 1).
 * Returns nothing; this becomes the new baseline for the next poll.
 */
export async function saveState(databaseUrl: string, state: PollState): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    `INSERT INTO poll_state (id, auth_alert_sent)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET auth_alert_sent = $1`,
    [state.authAlertSent],
  );
}
