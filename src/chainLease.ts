import type { Pool } from "pg";
import { getPool } from "./db.js";

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the poll_chain table exists first
 * (once per process instance). The table holds a single row that acts as the
 * cross-invocation lock and clock for the self-chaining poll loop.
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS poll_chain (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        runner_id TEXT,
        lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Attempts to become the single active chain runner by claiming the lease for
 * `ttlMs`. The claim is one atomic statement, so of any number of concurrent
 * invocations exactly one wins — this is what stops a duplicate chain from forming
 * (and double-posting every alert) when the endpoint is triggered while a segment is
 * already running. Returns true if this runner now holds the lease, false if another
 * runner holds a still-valid one. Creates the singleton row on first use.
 */
export async function claimChainLease(
  databaseUrl: string,
  runnerId: string,
  ttlMs: number,
): Promise<boolean> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    `INSERT INTO poll_chain (id, runner_id, lease_expires_at, next_poll_at)
     VALUES (1, $1, now() + make_interval(secs => $2::double precision / 1000.0), now())
     ON CONFLICT (id) DO UPDATE
       SET runner_id = $1, lease_expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
       WHERE poll_chain.lease_expires_at < now()
     RETURNING runner_id`,
    [runnerId, ttlMs],
  );
  return result.rows.length > 0;
}

/**
 * Extends this runner's lease by `ttlMs`, called once per loop iteration so a live
 * segment keeps other invocations out. Returns false if the lease was lost — meaning
 * this segment stalled long enough for another runner to take over — which the caller
 * must treat as a signal to stop immediately rather than keep polling in parallel.
 */
export async function renewChainLease(
  databaseUrl: string,
  runnerId: string,
  ttlMs: number,
): Promise<boolean> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    `UPDATE poll_chain
     SET lease_expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
     WHERE id = 1 AND runner_id = $1
     RETURNING runner_id`,
    [runnerId, ttlMs],
  );
  return result.rows.length > 0;
}

/**
 * Expires this runner's lease so the next segment can claim it. Must be called before
 * the handoff request is sent: if the lease were still held when the successor starts,
 * the successor would see the chain as already running, exit, and the chain would die.
 * Returns nothing; no-ops if the lease has already been taken over.
 */
export async function releaseChainLease(databaseUrl: string, runnerId: string): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    "UPDATE poll_chain SET lease_expires_at = now() - interval '1 second' WHERE id = 1 AND runner_id = $1",
    [runnerId],
  );
}

/**
 * Returns the timestamp at which the next poll is due. Persisting this rather than
 * sleeping a fixed interval is what keeps the real cadence at POLL_INTERVAL_MS across
 * segment boundaries — a handoff mid-interval resumes the remaining wait instead of
 * restarting or skipping it.
 */
export async function getNextPollAt(databaseUrl: string): Promise<Date> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ next_poll_at: Date }>(
    "SELECT next_poll_at FROM poll_chain WHERE id = 1",
  );
  return result.rows[0]?.next_poll_at ?? new Date();
}

/**
 * Records when the next poll becomes due, written immediately after each completed
 * poll. Returns nothing; only the current lease holder can write it.
 */
export async function setNextPollAt(
  databaseUrl: string,
  runnerId: string,
  nextPollAt: Date,
): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    "UPDATE poll_chain SET next_poll_at = $2 WHERE id = 1 AND runner_id = $1",
    [runnerId, nextPollAt],
  );
}
