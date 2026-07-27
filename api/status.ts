import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../src/config.js";
import { loadState } from "../src/stateStore.js";
import { getNextPollAt } from "../src/pollLock.js";
import { getChannelIds } from "../src/channelStore.js";
import { log } from "../src/logger.js";

const STALE_AFTER_INTERVALS = 3;

/**
 * Reports whether the bot is actually still checking, without needing logs or database
 * access. Answers the question the poll endpoint cannot: silence from the bot is
 * ambiguous between "no tickets yet" and "nothing has run in hours", and this
 * distinguishes them.
 *
 * `healthy` is false once no poll has been recorded for STALE_AFTER_INTERVALS times
 * POLL_INTERVAL_MS, which is the signal to watch — most uptime pingers can be told to
 * alert when a response body stops matching an expected string, turning a stalled bot
 * into a notification rather than something discovered too late.
 *
 * Deliberately unauthenticated and read-only: it exposes only what is being watched
 * and when it was last checked — no tokens, channel ids, or server names. Responds 200
 * with the status document, 405 on a non-GET, or 500 if config or the database is
 * unreachable (itself a useful signal).
 */
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const config = loadConfig();
    const [state, nextPollAt, channelIds] = await Promise.all([
      loadState(config.databaseUrl),
      getNextPollAt(config.databaseUrl),
      getChannelIds(config.databaseUrl),
    ]);

    const now = Date.now();
    const lastPolledAt = state.lastPolledAt;
    const minutesSinceLastPoll =
      lastPolledAt === null ? null : Math.round((now - lastPolledAt.getTime()) / 60_000);
    const healthy =
      lastPolledAt !== null &&
      now - lastPolledAt.getTime() < config.pollIntervalMs * STALE_AFTER_INTERVALS;

    response.status(200).json({
      healthy,
      watching: {
        movie: config.movieName,
        movieId: config.movieId,
        showDate: config.showDate,
        location: config.location,
      },
      lastPoll: {
        at: lastPolledAt?.toISOString() ?? null,
        minutesAgo: minutesSinceLastPoll,
        status: state.lastPollStatus,
        sessionsOnSale: state.lastSessionCount,
      },
      nextPollDueAt: nextPollAt.toISOString(),
      pollIntervalMinutes: Math.round(config.pollIntervalMs / 60_000),
      alertChannels: channelIds.length,
      authTokenExpired: state.authAlertSent,
    });
  } catch (error) {
    log("error", "Status check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ healthy: false, error: "Status unavailable" });
  }
}
