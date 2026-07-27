import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadEndpointConfig, loadConfig } from "../src/config.js";
import { acquirePollLock } from "../src/pollLock.js";
import { runScheduledPoll } from "../src/scheduledPoll.js";
import { log } from "../src/logger.js";

/**
 * Compares a presented bearer token against the expected secret without leaking
 * length or content through timing. Both sides are SHA-256 hashed first so the
 * constant-time comparison always runs over equal-length buffers. Returns true only
 * on an exact match.
 */
function isAuthorized(header: string | undefined, expectedSecret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Runs one poll per request, so the bot's cadence comes from whatever external
 * scheduler triggers this endpoint. It deliberately does not invoke itself to continue
 * polling: Vercel blocks a deployment from calling itself past a few hops with a 508
 * INFINITE_LOOP_DETECTED, which makes any self-chaining loop impossible here.
 *
 * Responds 200 `polled` when a poll ran, 200 `not-due` when triggered before
 * POLL_INTERVAL_MS has elapsed (so over-frequent triggers are harmless), 200 `busy`
 * when another invocation holds the lock, 401 on a bad secret, and 405 on an
 * unsupported method. Safe to call at any frequency and from anywhere.
 */
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST" && request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let config;
  let endpointConfig;
  try {
    config = loadConfig();
    endpointConfig = loadEndpointConfig();
  } catch (error) {
    log("error", "Invalid configuration", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ error: "Invalid configuration" });
    return;
  }

  if (!isAuthorized(request.headers.authorization, endpointConfig.pollSecret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const holderId = randomUUID();
  const locked = await acquirePollLock(config.databaseUrl, holderId, endpointConfig.lockTtlMs);

  if (!locked) {
    response.status(200).json({ status: "busy" });
    return;
  }

  const outcome = await runScheduledPoll(config, holderId);
  response.status(200).json(outcome);
}
