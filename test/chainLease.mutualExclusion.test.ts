import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  claimChainLease,
  getNextPollAt,
  releaseChainLease,
  renewChainLease,
  setNextPollAt,
} from "../src/chainLease.js";
import { closePool, getPool } from "../src/db.js";

/**
 * Verifies the mutual-exclusion guarantees the self-chaining poll loop depends on:
 * only one runner may hold the lease at a time, a runner that lost the lease cannot
 * renew or write the clock, and releasing hands control to the next runner. A
 * regression here would let two chains run in parallel and double-post every alert, or
 * strand the chain with a lease nobody can claim.
 *
 * Requires a reachable DATABASE_URL. Run with: npx tsx test/chainLease.mutualExclusion.test.ts
 * Restores the poll_chain row to an unclaimed state on exit.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set to run this test");

  const runnerA = randomUUID();
  const runnerB = randomUUID();
  const ttlMs = 60_000;

  await getNextPollAt(databaseUrl);

  await getPool(databaseUrl).query(
    `INSERT INTO poll_chain (id, runner_id, lease_expires_at, next_poll_at)
     VALUES (1, NULL, now() - interval '1 second', now())
     ON CONFLICT (id) DO UPDATE SET runner_id = NULL, lease_expires_at = now() - interval '1 second'`,
  );

  assert.equal(await claimChainLease(databaseUrl, runnerA, ttlMs), true, "A should claim a free lease");
  assert.equal(await claimChainLease(databaseUrl, runnerB, ttlMs), false, "B must not claim A's live lease");

  assert.equal(await renewChainLease(databaseUrl, runnerA, ttlMs), true, "A should renew its own lease");
  assert.equal(await renewChainLease(databaseUrl, runnerB, ttlMs), false, "B must not renew a lease it lacks");

  const dueAt = new Date(Date.now() + 30_000);
  await setNextPollAt(databaseUrl, runnerB, dueAt);
  const afterBogusWrite = await getNextPollAt(databaseUrl);
  assert.ok(
    Math.abs(afterBogusWrite.getTime() - dueAt.getTime()) > 1_000,
    "B must not move the poll clock while A holds the lease",
  );

  await setNextPollAt(databaseUrl, runnerA, dueAt);
  const afterValidWrite = await getNextPollAt(databaseUrl);
  assert.ok(
    Math.abs(afterValidWrite.getTime() - dueAt.getTime()) < 1_000,
    "A should move the poll clock",
  );

  await releaseChainLease(databaseUrl, runnerA);
  assert.equal(await claimChainLease(databaseUrl, runnerB, ttlMs), true, "B should claim after A releases");
  assert.equal(await renewChainLease(databaseUrl, runnerA, ttlMs), false, "A must not renew after handoff");

  await releaseChainLease(databaseUrl, runnerB);
  await closePool();

  console.log("chainLease mutual-exclusion: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
