import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadChainConfig, loadConfig } from "../src/config.js";
import { claimChainLease } from "../src/chainLease.js";
import { runChainSegment } from "../src/chainRunner.js";
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
 * Entry point for the self-chaining poll loop. Each request tries to become the single
 * active chain runner: it claims the database lease, responds immediately, and then
 * continues polling in the background via `waitUntil` until its time budget is spent,
 * at which point it calls this same endpoint again to spawn its successor.
 *
 * Responds 202 when this request started a segment, 200 when a segment is already
 * running (so duplicate triggers are harmless no-ops rather than a second chain),
 * 401 on a bad secret, and 405 on an unsupported method. Because it is idempotent,
 * hitting this endpoint by hand — or from any external pinger — is also how a chain
 * that died mid-flight gets restarted.
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
  let chainConfig;
  try {
    config = loadConfig();
    chainConfig = loadChainConfig();
  } catch (error) {
    log("error", "Invalid configuration", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ error: "Invalid configuration" });
    return;
  }

  if (!isAuthorized(request.headers.authorization, chainConfig.chainSecret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const runnerId = randomUUID();
  const claimed = await claimChainLease(config.databaseUrl, runnerId, chainConfig.leaseTtlMs);

  if (!claimed) {
    response.status(200).json({ status: "already-running" });
    return;
  }

  log("info", "Chain segment started", { runnerId, budgetMs: chainConfig.segmentBudgetMs });
  waitUntil(runChainSegment(config, chainConfig, runnerId));
  response.status(202).json({ status: "started", runnerId });
}
