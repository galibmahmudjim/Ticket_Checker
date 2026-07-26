import type { AppConfig } from "./config.js";
import { fetchShowdates, CineplexAuthError } from "./cineplexClient.js";
import { findNewEntries } from "./showtimeDiff.js";
import { formatShowEntry, sendDiscordMessage } from "./discordNotifier.js";
import { log } from "./logger.js";
import type { PollState } from "./stateStore.js";

/**
 * Runs exactly one poll: fetches showdates for the configured movie, diffs them
 * against the previous state, and DMs a Discord alert when genuinely new showtimes
 * appear. On the first-ever poll (state.hasPolledBefore === false) it only records a
 * baseline and never alerts, since there's nothing to compare against yet. On auth
 * failure it DMs a warning (rate-limited by config.authErrorAlertCooldownMs, tracked
 * via state.lastAuthAlertAt) asking for a fresh token, rather than attempting to
 * bypass login itself. Returns the updated PollState for the caller to persist;
 * never throws — poll and Discord failures are logged and swallowed so a single bad
 * cycle (in-process loop or one-shot GitHub Actions run) doesn't crash the caller.
 */
export async function runPollCycle(config: AppConfig, state: PollState): Promise<PollState> {
  try {
    const entries = await fetchShowdates(config);
    const { newEntries, allFingerprints } = findNewEntries(entries, state.fingerprints);

    if (state.hasPolledBefore && newEntries.length > 0) {
      const lines = newEntries.map((entry) => `- ${formatShowEntry(entry)}`).join("\n");
      await sendDiscordMessage(
        config.discordBotToken,
        config.discordUserId,
        `🎬 **New showtime(s) available for ${config.movieName}!**\n${lines}\nBook now: https://ticket.cineplexbd.com`,
      );
      log("info", "Sent Discord alert for new showtimes", { count: newEntries.length });
    }

    return {
      fingerprints: allFingerprints,
      hasPolledBefore: true,
      lastAuthAlertAt: state.lastAuthAlertAt,
    };
  } catch (error) {
    if (error instanceof CineplexAuthError) {
      log("warn", "Cineplex auth token expired or invalid", { message: error.message });
      const now = Date.now();
      if (now - state.lastAuthAlertAt > config.authErrorAlertCooldownMs) {
        await sendDiscordMessage(
          config.discordBotToken,
          config.discordUserId,
          "⚠️ Cineplex auth token expired. Grab a fresh token from the browser, update `CINEPLEX_AUTH_TOKEN`, and restart the bot.",
        ).catch((notifyError: unknown) =>
          log("error", "Failed to send auth-expiry alert", { error: String(notifyError) }),
        );
        return { ...state, lastAuthAlertAt: now };
      }
      return state;
    }

    log("error", "Poll failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return state;
  }
}
