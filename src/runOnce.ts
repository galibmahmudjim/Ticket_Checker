import { loadConfig } from "./config.js";
import { loadState, saveState } from "./stateStore.js";
import { runPollCycle } from "./pollCycle.js";
import { log } from "./logger.js";

/**
 * Single-shot entry point for GitHub Actions (or any other cron-style scheduler that
 * spins up a fresh process per invocation rather than staying alive). Loads config
 * and prior state, runs exactly one runPollCycle, persists the result, and exits.
 * Unlike index.ts, this never sends a "bot started" DM — a scheduler invoking this
 * every few minutes would spam that message on every run. Explicitly exits after
 * completion since the open Postgres connection pool would otherwise keep the
 * process alive indefinitely.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const state = await loadState(config.databaseUrl);

  log("info", "Running one-shot poll", { movieId: config.movieId });

  const updatedState = await runPollCycle(config, state);
  await saveState(config.databaseUrl, updatedState);

  log("info", "One-shot poll complete");
  process.exit(0);
}

main().catch((error: unknown) => {
  log("error", "Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
