import type { AppConfig, ChainConfig } from "./config.js";
import { loadState, saveState, type PollState } from "./stateStore.js";
import { runPollCycle } from "./pollCycle.js";
import { syncGuilds } from "./guildSync.js";
import {
  getNextPollAt,
  releaseChainLease,
  renewChainLease,
  setNextPollAt,
} from "./chainLease.js";
import { log } from "./logger.js";

const MAX_SLEEP_MS = 15_000;
const HANDOFF_RESERVE_MS = 5_000;
const HANDOFF_TIMEOUT_MS = 10_000;

/**
 * Waits for `ms` milliseconds. Returns a promise that always resolves; used for the
 * between-poll delay inside a segment.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends the handoff request that starts the next segment, authenticating with the
 * shared secret. The successor claims the lease and responds before doing any work,
 * so this call returns in well under the timeout rather than blocking for the
 * successor's whole run. Returns nothing; throws if the request fails or times out,
 * which the caller logs as a broken chain.
 */
async function triggerNextSegment(chainConfig: ChainConfig): Promise<void> {
  const response = await fetch(`${chainConfig.selfBaseUrl}/api/poll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${chainConfig.chainSecret}` },
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Handoff request failed (${response.status}): ${await response.text()}`);
  }
}

/**
 * Runs one segment of the self-chaining poll loop: repeatedly syncs guild
 * registrations and polls Cineplex until the segment's time budget is nearly spent,
 * then releases its lease and triggers a successor invocation so polling continues.
 * Poll cadence is driven by the persisted `next_poll_at` rather than a fixed sleep, so
 * the real interval stays at POLL_INTERVAL_MS across segment boundaries. Aborts
 * without handing off if the lease is lost mid-segment, since that means another
 * runner has already taken over and continuing would double-post every alert. Returns
 * nothing; never throws — a failed handoff is logged, and because the lease is already
 * released by then, any later request to the endpoint restarts the chain.
 */
export async function runChainSegment(
  config: AppConfig,
  chainConfig: ChainConfig,
  runnerId: string,
): Promise<void> {
  const deadline = Date.now() + chainConfig.segmentBudgetMs;
  let state: PollState = await loadState(config.databaseUrl);
  let handOff = true;

  try {
    while (Date.now() < deadline - HANDOFF_RESERVE_MS) {
      if (!(await renewChainLease(config.databaseUrl, runnerId, chainConfig.leaseTtlMs))) {
        log("warn", "Lost chain lease; another runner took over", { runnerId });
        handOff = false;
        return;
      }

      const waitMs = (await getNextPollAt(config.databaseUrl)).getTime() - Date.now();

      if (waitMs > 0) {
        await sleep(Math.min(waitMs, MAX_SLEEP_MS, deadline - HANDOFF_RESERVE_MS - Date.now()));
        continue;
      }

      await syncGuilds(config.discordBotToken, config.databaseUrl);
      state = await runPollCycle(config, state);
      await saveState(config.databaseUrl, state);
      await setNextPollAt(
        config.databaseUrl,
        runnerId,
        new Date(Date.now() + config.pollIntervalMs),
      );
    }
  } catch (error) {
    log("error", "Chain segment failed; handing off anyway", {
      runnerId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (handOff) {
      await releaseChainLease(config.databaseUrl, runnerId).catch((error: unknown) =>
        log("error", "Failed to release chain lease", { error: String(error) }),
      );
      try {
        await triggerNextSegment(chainConfig);
        log("info", "Handed off to next segment", { runnerId });
      } catch (error) {
        log("error", "CHAIN BROKEN: handoff failed, polling has stopped until /api/poll is hit", {
          runnerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
