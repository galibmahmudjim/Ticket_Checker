import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { acquirePollLock, releasePollLock, setNextPollAt } from "./pollLock.js";
import { loadState, saveState, type PollState } from "./stateStore.js";
import { closePool } from "./db.js";
import { runPollCycle } from "./pollCycle.js";
import { sendDiscordMessage } from "./discordNotifier.js";
import { getChannelIds } from "./channelStore.js";
import { syncGuilds } from "./guildSync.js";
import { log } from "./logger.js";

/**
 * Long-running entry point, used for local development and any always-on host. Loads
 * config and prior state, reconciles guild registrations over Discord's REST API,
 * posts a one-time "bot started" message to the registered channels, then loops
 * forever on POLL_INTERVAL_MS calling runPollCycle and persisting state after every
 * cycle. On Vercel this file is not used at all — `api/poll.ts` drives the same
 * runPollCycle one poll per request instead, because a serverless function cannot host
 * a loop like this one.
 *
 * Each cycle takes the same `poll_lock` the HTTP endpoint uses and writes
 * `next_poll_at` after polling, so the database reflects this loop's schedule rather
 * than only the endpoint's, and so the two coordinate instead of polling over each
 * other if both ever run against one database. A cycle that cannot take the lock is
 * skipped rather than queued — another poller has just done the work.
 *
 * Returns when the process receives SIGINT/SIGTERM.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  let state: PollState = await loadState(config.databaseUrl);
  let isShuttingDown = false;
  let interruptSleep: (() => void) | undefined;

  /**
   * Waits for `ms` milliseconds, or returns immediately if shutdown() is called first.
   * Returns a promise that always resolves; used for the between-poll delay so the
   * process reacts to SIGINT/SIGTERM right away instead of finishing a long sleep first.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      interruptSleep = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });

  log("info", "Starting Cineplex ticket watcher", {
    movieId: config.movieId,
    pollIntervalMs: config.pollIntervalMs,
  });

  await syncGuilds(config.discordBotToken, config.databaseUrl);

  const channelIds = await getChannelIds(config.databaseUrl);
  if (channelIds.length > 0) {
    await sendDiscordMessage(
      config.discordBotToken,
      channelIds,
      `👋 Hi, this is a hobby project by Galib Mahmud Jim — let's see if it works!\n\n🤖 moviebot started — watching ${config.movieName} for new showtimes. You'll see a message here the moment tickets appear.`,
    ).catch((error: unknown) =>
      log("error", "Failed to post startup message", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } else {
    log("warn", "No channels registered yet — add the bot to a server to register one");
  }

  const shutdown = (): void => {
    if (isShuttingDown) {
      return;
    }
    log("info", "Shutting down");
    isShuttingDown = true;
    interruptSleep?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!isShuttingDown) {
    const holderId = randomUUID();
    if (await acquirePollLock(config.databaseUrl, holderId, config.lockTtlMs)) {
      try {
        await syncGuilds(config.discordBotToken, config.databaseUrl);
        state = await runPollCycle(config, state);
        await saveState(config.databaseUrl, state);
        await setNextPollAt(
          config.databaseUrl,
          holderId,
          new Date(Date.now() + config.pollIntervalMs),
        );
      } finally {
        await releasePollLock(config.databaseUrl, holderId);
      }
    } else {
      log("warn", "Another poller holds the lock; skipping this cycle", { holderId });
    }
    if (!isShuttingDown) {
      await sleep(config.pollIntervalMs);
    }
  }

  await closePool();
}

main().catch((error: unknown) => {
  log("error", "Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
