import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadState, saveState, closePool, type PollState } from "./stateStore.js";
import { runPollCycle } from "./pollCycle.js";
import { sendDiscordMessage } from "./discordNotifier.js";
import { log } from "./logger.js";

const HEARTBEAT_PATH = process.env.HEARTBEAT_FILE_PATH ?? "./data/heartbeat";

/**
 * Writes the current timestamp to the heartbeat file, creating parent directories
 * as needed. Returns nothing; the Docker HEALTHCHECK reads this file's mtime to
 * confirm the poll loop is still alive.
 */
async function touchHeartbeat(): Promise<void> {
  await fs.mkdir(path.dirname(HEARTBEAT_PATH), { recursive: true });
  await fs.writeFile(HEARTBEAT_PATH, new Date().toISOString(), "utf-8");
}

/**
 * Long-lived entry point for local/Docker use: loads config and prior state, sends a
 * one-time "bot started" DM, then loops forever calling runPollCycle on
 * POLL_INTERVAL_MS, persisting the resulting state and touching the heartbeat file
 * after every cycle. Returns when the process receives SIGINT/SIGTERM. For a
 * single-shot run (e.g. GitHub Actions cron), use runOnce.ts instead.
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

  await sendDiscordMessage(
    config.discordBotToken,
    config.discordUserId,
    `👋 Hi, this is a hobby project by Galib Mahmud Jim — let's see if it works!\n\n🤖 moviebot started — watching ${config.movieName} for new showtimes. You'll get a message here the moment tickets appear.`,
  ).catch((error: unknown) =>
    log("error", "Failed to send startup DM", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );

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
    state = await runPollCycle(config, state);
    await saveState(config.databaseUrl, state);
    await touchHeartbeat();
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
