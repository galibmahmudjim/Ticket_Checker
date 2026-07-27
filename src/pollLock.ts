import type { Pool } from "pg";
import { getPool } from "./db.js";

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the poll_lock table exists first
 * (once per process instance). The table holds a single row carrying both the
 * advisory lock that keeps concurrent invocations from polling at the same time and
 * the timestamp of the next due poll.
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS poll_lock (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        holder_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Attempts to take the poll lock for `ttlMs`. The claim is one atomic statement, so of
 * any number of overlapping triggers exactly one proceeds — this stops a slow poll
 * from being run over the top of by the next scheduled ping, which would post
 * duplicate alerts. Returns true if this holder now owns the lock, false if another
 * invocation holds a still-valid one. Creates the singleton row on first use.
 */
export async function acquirePollLock(
  databaseUrl: string,
  holderId: string,
  ttlMs: number,
): Promise<boolean> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    `INSERT INTO poll_lock (id, holder_id, expires_at, next_poll_at)
     VALUES (1, $1, now() + make_interval(secs => $2::double precision / 1000.0), now())
     ON CONFLICT (id) DO UPDATE
       SET holder_id = $1, expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
       WHERE poll_lock.expires_at < now()
     RETURNING holder_id`,
    [holderId, ttlMs],
  );
  return result.rows.length > 0;
}

/**
 * Expires this holder's lock so the next trigger can take it immediately rather than
 * waiting out the TTL. Returns nothing; no-ops if the lock has already been taken over
 * (e.g. this invocation overran its TTL).
 */
export async function releasePollLock(databaseUrl: string, holderId: string): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    "UPDATE poll_lock SET expires_at = now() - interval '1 second' WHERE id = 1 AND holder_id = $1",
    [holderId],
  );
}

/**
 * Returns the timestamp at which the next poll becomes due. This is what keeps the
 * effective cadence at POLL_INTERVAL_MS no matter how often the endpoint is triggered:
 * a trigger arriving early is answered without calling Cineplex at all.
 */
export async function getNextPollAt(databaseUrl: string): Promise<Date> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ next_poll_at: Date }>(
    "SELECT next_poll_at FROM poll_lock WHERE id = 1",
  );
  return result.rows[0]?.next_poll_at ?? new Date();
}

/**
 * Records when the next poll becomes due, written immediately after each completed
 * poll. Returns nothing; only the current lock holder can write it.
 */
export async function setNextPollAt(
  databaseUrl: string,
  holderId: string,
  nextPollAt: Date,
): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query("UPDATE poll_lock SET next_poll_at = $2 WHERE id = 1 AND holder_id = $1", [
    holderId,
    nextPollAt,
  ]);
}
