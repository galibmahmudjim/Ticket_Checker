import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  acquirePollLock,
  getNextPollAt,
  releasePollLock,
  setNextPollAt,
} from "../src/pollLock.js";
import { closePool, getPool } from "../src/db.js";

/**
 * Verifies the mutual exclusion the poll endpoint depends on: only one invocation may
 * hold the lock at a time, a holder that lost it cannot move the poll clock, and
 * releasing hands control to the next trigger. A regression here would let two
 * overlapping triggers poll simultaneously and post duplicate alerts.
 *
 * Requires a reachable DATABASE_URL. Run with: npx tsx test/pollLock.mutualExclusion.test.ts
 * Restores the poll_lock row to an unheld state on exit.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set to run this test");

  const holderA = randomUUID();
  const holderB = randomUUID();
  const ttlMs = 60_000;

  await getNextPollAt(databaseUrl);

  await getPool(databaseUrl).query(
    `INSERT INTO poll_lock (id, holder_id, expires_at, next_poll_at)
     VALUES (1, NULL, now() - interval '1 second', now())
     ON CONFLICT (id) DO UPDATE SET holder_id = NULL, expires_at = now() - interval '1 second'`,
  );

  assert.equal(await acquirePollLock(databaseUrl, holderA, ttlMs), true, "A should take a free lock");
  assert.equal(await acquirePollLock(databaseUrl, holderB, ttlMs), false, "B must not take A's live lock");

  const dueAt = new Date(Date.now() + 30_000);
  await setNextPollAt(databaseUrl, holderB, dueAt);
  const afterBogusWrite = await getNextPollAt(databaseUrl);
  assert.ok(
    Math.abs(afterBogusWrite.getTime() - dueAt.getTime()) > 1_000,
    "B must not move the poll clock while A holds the lock",
  );

  await setNextPollAt(databaseUrl, holderA, dueAt);
  const afterValidWrite = await getNextPollAt(databaseUrl);
  assert.ok(
    Math.abs(afterValidWrite.getTime() - dueAt.getTime()) < 1_000,
    "A should move the poll clock",
  );

  await releasePollLock(databaseUrl, holderA);
  assert.equal(await acquirePollLock(databaseUrl, holderB, ttlMs), true, "B should take it after A releases");

  await releasePollLock(databaseUrl, holderB);
  await getPool(databaseUrl).query("UPDATE poll_lock SET next_poll_at = now()");
  await closePool();

  console.log("pollLock mutual-exclusion: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
