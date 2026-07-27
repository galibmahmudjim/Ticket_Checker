import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { closePool, getPool } from "../src/db.js";

interface Reply {
  readonly httpStatus: number;
  readonly body: { status?: string; error?: string; dueInMs?: number };
}

/**
 * Drives the real `api/poll.ts` handler over a local HTTP server to verify the
 * contract every external scheduler relies on: an authorised trigger polls, a trigger
 * arriving before POLL_INTERVAL_MS has elapsed is answered "not-due" without touching
 * Cineplex, and an unauthorised trigger is rejected. Together these are what make the
 * endpoint safe to ping at any frequency from anywhere.
 *
 * Requires DISCORD_BOT_TOKEN, DATABASE_URL and a valid Cineplex token.
 * Run with: npx tsx test/pollEndpoint.behaviour.test.ts
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
      const { default: handler } = await import("../api/poll.js");
      await handler(request as VercelRequest, shimmed);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/poll`;

  const call = async (token: string | undefined): Promise<Reply> => {
    const response = await fetch(url, {
      method: "POST",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    return { httpStatus: response.status, body: (await response.json()) as Reply["body"] };
  };

  const unauthorised = await call(undefined);
  assert.equal(unauthorised.httpStatus, 401, "a trigger without the secret must be rejected");

  const wrongSecret = await call("not-the-secret");
  assert.equal(wrongSecret.httpStatus, 401, "a trigger with a wrong secret must be rejected");

  await getPool(databaseUrl).query("UPDATE poll_lock SET next_poll_at = now()");
  const due = await call(secret);
  assert.equal(due.httpStatus, 200, "an authorised due trigger should succeed");
  assert.equal(due.body.status, "polled", `expected a poll, got ${JSON.stringify(due.body)}`);

  const early = await call(secret);
  assert.equal(early.body.status, "not-due", "a trigger before the interval elapses must not poll");
  assert.ok((early.body.dueInMs ?? 0) > 0, "not-due should report when the next poll is due");
  console.log(`second trigger correctly skipped; next poll due in ${early.body.dueInMs}ms`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getPool(databaseUrl).query("UPDATE poll_lock SET next_poll_at = now()");
  await closePool();

  console.log("pollEndpoint behaviour: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
