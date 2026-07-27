import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../src/config.js";
import { loadState, saveState } from "../src/stateStore.js";
import { runPollCycle } from "../src/pollCycle.js";
import { log } from "../src/logger.js";

/**
 * Vercel Cron entry point: runs exactly one poll cycle and returns. Equivalent to
 * runOnce.ts, but as an HTTP handler instead of a CLI process, since Vercel Cron
 * triggers a URL rather than running a script. Rejects the request unless it carries
 * the CRON_SECRET Vercel signs cron-triggered requests with, so the endpoint can't be
 * triggered by anyone who finds the URL (which would poll Cineplex on-demand and
 * could spam the Discord alert).
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const config = loadConfig();
  const state = await loadState(config.databaseUrl);

  log("info", "Running Vercel-triggered poll", { movieId: config.movieId });

  const updatedState = await runPollCycle(config, state);
  await saveState(config.databaseUrl, updatedState);

  log("info", "Vercel-triggered poll complete");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
