import { loadConfig } from "./config.js";
import { loadState, saveState, type PollState } from "./stateStore.js";
import { closePool } from "./db.js";
import { runPollCycle } from "./pollCycle.js";
import { sendDiscordMessage } from "./discordNotifier.js";
import { getRecipients } from "./recipientStore.js";
import { startDiscordGateway } from "./discordGateway.js";
import { log } from "./logger.js";

/**
 * Entry point: loads config and prior state, connects the Discord Gateway (so newly
 * joined servers' owners get registered as recipients — see discordGateway.ts), sends
 * a one-time "bot started" DM to whoever's already registered, then loops forever
 * calling runPollCycle on POLL_INTERVAL_MS, persisting the resulting state after
 * every cycle. Returns when the process receives SIGINT/SIGTERM.
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

  const gatewayClient = await startDiscordGateway(config.discordBotToken, config.databaseUrl);

  const recipients = await getRecipients(config.databaseUrl);
  if (recipients.length > 0) {
    await sendDiscordMessage(
      config.discordBotToken,
      recipients,
      `👋 Hi, this is a hobby project by Galib Mahmud Jim — let's see if it works!\n\n🤖 moviebot started — watching ${config.movieName} for new showtimes. You'll get a message here the moment tickets appear.`,
    ).catch((error: unknown) =>
      log("error", "Failed to send startup DM", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } else {
    log("warn", "No recipients registered yet — add the bot to a server to register its owner");
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
    state = await runPollCycle(config, state);
    await saveState(config.databaseUrl, state);
    if (!isShuttingDown) {
      await sleep(config.pollIntervalMs);
    }
  }

  gatewayClient.destroy();
  await closePool();
}

main().catch((error: unknown) => {
  log("error", "Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
