import type { AppConfig } from "./config.js";
import { fetchShows, CineplexAuthError } from "./cineplexClient.js";
import { findNewEntries } from "./showtimeDiff.js";
import { formatShowSessions, sendDiscordMessage } from "./discordNotifier.js";
import { log } from "./logger.js";
import type { PollState } from "./stateStore.js";

/**
 * Runs exactly one poll: fetches get-shows sessions for the fixed
 * movieId/location/showDate in config, diffs them against the previous state, and DMs
 * a Discord alert when genuinely new sessions appear. On the first-ever poll
 * (state.hasPolledBefore === false) it only records a baseline and never alerts,
 * since there's nothing to compare against yet. On auth failure it DMs a warning
 * exactly once (tracked via state.authAlertSent) asking for a fresh token, then stays
 * silent on repeat failures until a poll succeeds again, at which point the flag
 * resets so a future failure alerts again. Returns the updated PollState for the
 * caller to persist; never throws — poll and Discord failures are logged and
 * swallowed so a single bad cycle doesn't crash the caller's loop.
 */
export async function runPollCycle(config: AppConfig, state: PollState): Promise<PollState> {
  try {
    const sessions = await fetchShows(config);
    const { newEntries, allFingerprints } = findNewEntries(sessions, state.fingerprints);

    if (state.hasPolledBefore && newEntries.length > 0) {
      const lines = formatShowSessions(newEntries).map((line) => `- ${line}`);
      await sendDiscordMessage(
        config.discordBotToken,
        config.discordUserIds,
        `🎬 **New showtime(s) available for ${config.movieName}!**\n${lines.join("\n")}\nBook now: https://ticket.cineplexbd.com`,
      );
      log("info", "Sent Discord alert for new showtimes", { count: newEntries.length });
    }

    return {
      fingerprints: allFingerprints,
      hasPolledBefore: true,
      authAlertSent: false,
    };
  } catch (error) {
    if (error instanceof CineplexAuthError) {
      log("warn", "Cineplex auth token expired or invalid", { message: error.message });
      if (!state.authAlertSent) {
        await sendDiscordMessage(
          config.discordBotToken,
          config.discordUserIds,
          "⚠️ Cineplex auth token expired. Grab a fresh token from the browser, update `CINEPLEX_AUTH_TOKEN`, and restart the bot.",
        ).catch((notifyError: unknown) =>
          log("error", "Failed to send auth-expiry alert", { error: String(notifyError) }),
        );
        return { ...state, authAlertSent: true };
      }
      return state;
    }

    log("error", "Poll failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return state;
  }
}
