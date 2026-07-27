import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadState } from "../src/stateStore.js";
import { closePool, getPool } from "../src/db.js";

interface StatusBody {
  healthy: boolean;
  watching: { movieId: number; movie: string; showDate: string };
  lastPoll: { at: string | null; minutesAgo: number | null; status: string | null; sessionsOnSale: number | null };
  alertChannels: number;
  pollIntervalMinutes: number;
}

/**
 * Verifies that a poll leaves a durable, queryable record of itself and that
 * /api/status reports it honestly — including flipping `healthy` to false once the
 * last poll is old enough. This is the mechanism that distinguishes "no tickets yet"
 * from "nothing has run in hours", so a regression here would make a dead bot look
 * exactly like a working one.
 *
 * Requires DISCORD_BOT_TOKEN, DATABASE_URL and a valid Cineplex token.
 * Run with: npx tsx test/pollStatus.tracking.test.ts
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set to run this test");
  process.env.POLL_SECRET ??= randomUUID();
  const secret = process.env.POLL_SECRET;

  const server = http.createServer((request, response) => {
    void (async (): Promise<void> => {
      const shimmed = response as unknown as VercelResponse;
      shimmed.status = (code: number): VercelResponse => {
        response.statusCode = code;
        return shimmed;
      };
      shimmed.json = (payload: unknown): VercelResponse => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
        return shimmed;
      };
      const route = request.url?.startsWith("/api/status") ? "status" : "poll";
      const { default: handler } = await import(`../api/${route}.js`);
      await handler(request as VercelRequest, shimmed);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const getStatus = async (): Promise<StatusBody> => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200, "status endpoint should answer 200");
    return (await response.json()) as StatusBody;
  };

  await getPool(databaseUrl).query("UPDATE poll_lock SET next_poll_at = now()");
  const pollResponse = await fetch(`${base}/api/poll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(((await pollResponse.json()) as { status: string }).status, "polled", "the poll should run");

  const persisted = await loadState(databaseUrl);
  assert.ok(persisted.lastPolledAt instanceof Date, "the poll must persist lastPolledAt");
  assert.equal(persisted.lastPollStatus, "ok", "a successful poll should record status ok");
  assert.equal(typeof persisted.lastSessionCount, "number", "session count should be recorded");

  const fresh = await getStatus();
  assert.equal(fresh.healthy, true, "a just-polled bot should report healthy");
  assert.ok((fresh.lastPoll.minutesAgo ?? 99) <= 1, "minutesAgo should be ~0 right after a poll");
  assert.equal(fresh.lastPoll.status, "ok");
  assert.ok(fresh.alertChannels > 0, "registered channels should be reported");
  console.log(
    `fresh: healthy=${fresh.healthy} movie=${fresh.watching.movieId} sessions=${fresh.lastPoll.sessionsOnSale} channels=${fresh.alertChannels}`,
  );

  await getPool(databaseUrl).query(
    "UPDATE poll_state SET last_polled_at = now() - interval '10 hours' WHERE id = 1",
  );
  const stale = await getStatus();
  assert.equal(stale.healthy, false, "a bot that hasn't polled in 10 hours must report unhealthy");
  assert.ok((stale.lastPoll.minutesAgo ?? 0) > 500, "minutesAgo should reflect the stale timestamp");
  console.log(`stale: healthy=${stale.healthy} minutesAgo=${stale.lastPoll.minutesAgo}`);

  await getPool(databaseUrl).query(
    "UPDATE poll_state SET last_polled_at = $1 WHERE id = 1",
    [persisted.lastPolledAt],
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();

  console.log("pollStatus tracking: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
