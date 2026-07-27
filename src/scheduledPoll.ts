import type { AppConfig } from "./config.js";
import { loadState, saveState } from "./stateStore.js";
import { runPollCycle } from "./pollCycle.js";
import { syncGuilds } from "./guildSync.js";
import { getNextPollAt, releasePollLock, setNextPollAt } from "./pollLock.js";
import { log } from "./logger.js";

export type PollOutcome =
  | { readonly status: "polled" }
  | { readonly status: "not-due"; readonly dueInMs: number };

/**
 * Runs at most one poll for a single external trigger: if a poll is due it syncs guild
 * registrations, polls Cineplex, alerts any channel with genuinely new sessions,
 * persists state, and schedules the next due time; if a trigger arrives early it
 * returns without calling Cineplex at all.
 *
 * The due-time check means the trigger's own frequency does not have to match
 * POLL_INTERVAL_MS — pinging more often than the interval is harmless, which keeps the
 * bot safe behind schedulers whose granularity you don't fully control. Assumes the
 * caller already holds the poll lock, and always releases it before returning. Returns
 * what it did so the endpoint can report it; never throws — `runPollCycle` and
 * `syncGuilds` swallow their own failures, and anything else is logged here.
 */
export async function runScheduledPoll(
  config: AppConfig,
  holderId: string,
): Promise<PollOutcome> {
  try {
    const dueInMs = (await getNextPollAt(config.databaseUrl)).getTime() - Date.now();
    if (dueInMs > 0) {
      log("info", "Trigger arrived before the next poll was due", { holderId, dueInMs });
      return { status: "not-due", dueInMs };
    }

    await syncGuilds(config.discordBotToken, config.databaseUrl);
    const state = await runPollCycle(config, await loadState(config.databaseUrl));
    await saveState(config.databaseUrl, state);
    await setNextPollAt(
      config.databaseUrl,
      holderId,
      new Date(Date.now() + config.pollIntervalMs),
    );

    return { status: "polled" };
  } catch (error) {
    log("error", "Scheduled poll failed", {
      holderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "polled" };
  } finally {
    await releasePollLock(config.databaseUrl, holderId).catch((error: unknown) =>
      log("error", "Failed to release poll lock", { error: String(error) }),
    );
  }
}
