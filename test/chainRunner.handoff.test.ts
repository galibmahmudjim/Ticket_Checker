import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { closePool } from "../src/db.js";

const OBSERVATION_MS = 35_000;
const SEGMENT_BUDGET_MS = 12_000;

interface SegmentRecord {
  readonly runnerId: string;
  readonly status: string;
  readonly at: number;
}

/**
 * Drives the real `api/poll.ts` handler over a local HTTP server so the self-chaining
 * loop can be observed end to end without deploying: each segment hands off by calling
 * PUBLIC_BASE_URL, which is pointed at this server, so successors are spawned exactly
 * as they would be on Vercel. Asserts that the chain actually advances (several
 * distinct runner ids over the observation window) and that a concurrent trigger is
 * rejected as already-running rather than starting a second chain.
 *
 * POLL_INTERVAL_MS is overridden to 10 minutes so only the first segment polls
 * Cineplex, isolating the handoff mechanism from repeated API traffic. Closing the
 * server at the end deliberately breaks the chain, which is how the run terminates.
 *
 * Requires DISCORD_BOT_TOKEN, DATABASE_URL and a valid Cineplex token.
 * Run with: npx tsx test/chainRunner.handoff.test.ts
 */
async function main(): Promise<void> {
  const segments: SegmentRecord[] = [];

  const server = http.createServer((request, response) => {
    void (async (): Promise<void> => {
      const shimmed = response as unknown as VercelResponse;
      shimmed.status = (code: number): VercelResponse => {
        response.statusCode = code;
        return shimmed;
      };
      shimmed.json = (payload: unknown): VercelResponse => {
        const body = payload as { status?: string; runnerId?: string };
        segments.push({
          runnerId: body.runnerId ?? "-",
          status: body.status ?? `http-${response.statusCode}`,
          at: Date.now(),
        });
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

  process.env.CHAIN_SECRET ??= randomUUID();
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.CHAIN_SEGMENT_BUDGET_MS = String(SEGMENT_BUDGET_MS);
  process.env.CHAIN_LEASE_TTL_MS = "30000";
  process.env.POLL_INTERVAL_MS = "600000";

  const trigger = async (): Promise<number> => {
    const response = await fetch(`${process.env.PUBLIC_BASE_URL}/api/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CHAIN_SECRET}` },
    });
    return response.status;
  };

  const firstStatus = await trigger();
  assert.equal(firstStatus, 202, "first trigger should start a segment");

  const duplicateStatus = await trigger();
  assert.equal(duplicateStatus, 200, "a concurrent trigger must be rejected, not start a second chain");

  await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();

  const started = segments.filter((segment) => segment.status === "started");
  const rejected = segments.filter((segment) => segment.status === "already-running");
  const distinctRunners = new Set(started.map((segment) => segment.runnerId));

  for (const segment of segments) {
    console.log(
      `+${String(segment.at - segments[0]!.at).padStart(6)}ms  ${segment.status.padEnd(15)} ${segment.runnerId}`,
    );
  }

  assert.ok(rejected.length >= 1, "the duplicate trigger should have been rejected");
  assert.ok(
    distinctRunners.size >= 3,
    `chain should have advanced through several segments, saw ${distinctRunners.size}`,
  );
  assert.equal(distinctRunners.size, started.length, "every segment must have a distinct runner id");

  console.log(
    `chainRunner handoff: all assertions passed (${distinctRunners.size} segments in ${OBSERVATION_MS}ms)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
