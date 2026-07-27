import type { AppConfig } from "./config.js";
import { fetchShows, CineplexAuthError } from "./cineplexClient.js";
import { findNewEntries } from "./showtimeDiff.js";
import { formatShowSessions, sendDiscordMessage } from "./discordNotifier.js";
import {
  getChannelIds,
  getChannelStates,
  saveChannelState,
  type ChannelState,
} from "./channelStore.js";
import { log } from "./logger.js";
import type { PollState } from "./stateStore.js";

/**
 * Posts to one channel whatever sessions are new relative to that channel's own
 * fingerprint history, then records the updated history. A channel's first delivery
 * is worded as a "now watching" catch-up (it hasn't seen anything yet, so everything
 * on sale is news to it); later ones as "new showtime(s)". Returns nothing; throws
 * only if the Discord post or the state write fails, so callers can decide whether
 * to log-and-continue or retry.
 */
async function deliverToChannel(
  config: AppConfig,
  sessions: readonly unknown[],
  channel: ChannelState,
): Promise<void> {
  const { newEntries, allFingerprints } = findNewEntries(sessions, channel.fingerprints);

  if (newEntries.length > 0) {
    const heading = channel.hasPolledBefore
      ? `🎬 **New showtime(s) available for ${config.movieName}!**`
      : `🎬 **Now watching ${config.movieName} — showtime(s) currently on sale:**`;
    const lines = formatShowSessions(newEntries).map((line) => `- ${line}`);
    await sendDiscordMessage(
      config.discordBotToken,
      [channel.channelId],
      `${heading}\n${lines.join("\n")}\nBook now: https://ticket.cineplexbd.com`,
    );
    log("info", "Sent Discord alert", {
      count: newEntries.length,
      channelId: channel.channelId,
      firstPoll: !channel.hasPolledBefore,
    });
  }

  await saveChannelState(config.databaseUrl, {
    channelId: channel.channelId,
    fingerprints: allFingerprints,
    hasPolledBefore: true,
  });
}

/**
 * Runs exactly one poll: fetches get-shows sessions for the fixed
 * movieId/location/showDate in config once, then diffs them independently against
 * each registered channel's own fingerprint history (src/channelStore.ts), so each
 * channel only gets alerted about sessions genuinely new *to it* rather than
 * inheriting other channels' "already seen" state. A channel's first poll posts
 * whatever is currently on sale (worded as a "now watching" catch-up rather than
 * "new"), so a server that just added the bot immediately sees existing showtimes
 * instead of staying silent until something changes. On auth failure it posts a warning
 * exactly once (tracked via the global state.authAlertSent) asking for a fresh
 * token, then stays silent on repeat failures until a poll succeeds again, at which
 * point the flag resets so a future failure alerts again. Returns the updated global
 * PollState for the caller to persist; never throws — poll and Discord failures
 * (including a single channel's) are logged and swallowed so they don't crash the
 * caller's loop or block other channels.
 */
export async function runPollCycle(config: AppConfig, state: PollState): Promise<PollState> {
  try {
    const sessions = await fetchShows(config);
    const channels = await getChannelStates(config.databaseUrl);

    for (const channel of channels) {
      try {
        await deliverToChannel(config, sessions, channel);
      } catch (channelError) {
        log("error", "Failed to process channel; will retry next poll", {
          channelId: channel.channelId,
          error: channelError instanceof Error ? channelError.message : String(channelError),
        });
      }
    }

    return { authAlertSent: false };
  } catch (error) {
    if (error instanceof CineplexAuthError) {
      log("warn", "Cineplex auth token expired or invalid", { message: error.message });
      if (!state.authAlertSent) {
        try {
          const channelIds = await getChannelIds(config.databaseUrl);
          if (channelIds.length > 0) {
            await sendDiscordMessage(
              config.discordBotToken,
              channelIds,
              "⚠️ Cineplex auth token expired. Grab a fresh token from the browser, update `CINEPLEX_AUTH_TOKEN`, and restart the bot.",
            );
          }
        } catch (notifyError) {
          log("error", "Failed to send auth-expiry alert", { error: String(notifyError) });
        }
        return { authAlertSent: true };
      }
      return state;
    }

    log("error", "Poll failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return state;
  }
}
