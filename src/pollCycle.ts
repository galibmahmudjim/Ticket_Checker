import type { AppConfig } from "./config.js";
import { fetchShowdates, fetchShows, CineplexAuthError } from "./cineplexClient.js";
import { findNewEntries } from "./showtimeDiff.js";
import { formatShowEntry, formatShowSessions, sendDiscordMessage } from "./discordNotifier.js";
import { log } from "./logger.js";
import type { PollState } from "./stateStore.js";

/**
 * Extracts {location, movieId, showDate} from a showdate entry if present. Returns
 * undefined if the entry isn't an object or is missing any of those fields, so
 * get-shows enrichment can be skipped gracefully for an unexpected entry shape.
 */
function extractShowdateKey(
  entry: unknown,
): { readonly location: unknown; readonly movieId: unknown; readonly showDate: unknown } | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (record.location === undefined || record.movieId === undefined || record.showDate === undefined) {
    return undefined;
  }
  return { location: record.location, movieId: record.movieId, showDate: record.showDate };
}

/**
 * Builds the Discord line(s) for one new showdate entry: the base "date | Location N"
 * line, plus a get-shows lookup for that specific date/location to list actual
 * session times underneath it, if any come back. Never throws — a failed or empty
 * get-shows lookup just falls back to the base line alone, since the core "a new
 * showtime is on sale" alert shouldn't be blocked by this best-effort enrichment.
 */
async function formatNewEntry(config: AppConfig, entry: unknown): Promise<string> {
  const baseLine = `- ${formatShowEntry(entry)}`;
  const key = extractShowdateKey(entry);
  if (!key) {
    return baseLine;
  }

  try {
    const sessions = await fetchShows(config, key);
    const sessionLines = formatShowSessions(sessions);
    if (sessionLines.length === 0) {
      return baseLine;
    }
    return `${baseLine}\n${sessionLines.map((line) => `  - ${line}`).join("\n")}`;
  } catch (error) {
    log("warn", "get-shows lookup failed for new entry", {
      error: error instanceof Error ? error.message : String(error),
    });
    return baseLine;
  }
}

/**
 * Runs exactly one poll: fetches showdates for the configured movie, diffs them
 * against the previous state, and DMs a Discord alert (with session details pulled
 * from get-shows) when genuinely new showtimes appear. On the first-ever poll
 * (state.hasPolledBefore === false) it only records a baseline and never alerts,
 * since there's nothing to compare against yet. On auth failure it DMs a warning
 * exactly once (tracked via state.authAlertSent) asking for a fresh token, then stays
 * silent on repeat failures until a poll succeeds again, at which point the flag
 * resets so a future failure alerts again. Returns the updated PollState for the
 * caller to persist; never throws — poll and Discord failures are logged and
 * swallowed so a single bad cycle (in-process loop or one-shot GitHub Actions run)
 * doesn't crash the caller.
 */
export async function runPollCycle(config: AppConfig, state: PollState): Promise<PollState> {
  try {
    const entries = await fetchShowdates(config);
    const { newEntries, allFingerprints } = findNewEntries(entries, state.fingerprints);

    if (state.hasPolledBefore && newEntries.length > 0) {
      const lines = await Promise.all(newEntries.map((entry) => formatNewEntry(config, entry)));
      await sendDiscordMessage(
        config.discordBotToken,
        config.discordUserId,
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
          config.discordUserId,
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
