import { log } from "./logger.js";

const COMMON_DATE_KEYS = ["date", "show_date", "showDate"] as const;

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

/**
 * Formats one seatPrices entry (e.g. {seatTypeTitle: "Regular", unitPrice: 400}) as
 * "Regular ৳400". Returns undefined if the entry isn't shaped as expected.
 */
function formatSeatPrice(price: unknown): string | undefined {
  if (typeof price !== "object" || price === null) {
    return undefined;
  }
  const record = price as Record<string, unknown>;
  if (typeof record.seatTypeTitle !== "string" || typeof record.unitPrice !== "number") {
    return undefined;
  }
  return `${record.seatTypeTitle} ৳${record.unitPrice}`;
}

/**
 * Builds human-readable one-line descriptions of each show session in a get-shows
 * response — confirmed shape is a list of screenings, each with `showDate`,
 * `screenTitle`, and a `showTimes` list of {showTime, seatPrices}. Returns "2026-07-28
 * Hall N 11:20 (Regular ৳400, Premium ৳450)" per showtime, reading the date straight
 * from this response rather than relying on the caller's own copy of it; falls back
 * to the raw JSON for a screening that doesn't match this shape. Returns an empty
 * array if `sessions` isn't a list.
 */
export function formatShowSessions(sessions: unknown): readonly string[] {
  if (!Array.isArray(sessions)) {
    return [];
  }

  const lines: string[] = [];
  for (const screening of sessions) {
    if (typeof screening !== "object" || screening === null) {
      lines.push(String(screening));
      continue;
    }
    const record = screening as Record<string, unknown>;
    const date = firstDefined(record, COMMON_DATE_KEYS);
    const hall = record.screenTitle;
    const showTimes = record.showTimes;

    if (typeof hall !== "string" || !Array.isArray(showTimes) || showTimes.length === 0) {
      lines.push(JSON.stringify(record));
      continue;
    }

    const datePrefix = date !== undefined ? `${date} ` : "";

    for (const showTime of showTimes) {
      if (typeof showTime !== "object" || showTime === null) {
        continue;
      }
      const showTimeRecord = showTime as Record<string, unknown>;
      const time = showTimeRecord.showTime;
      const seatPrices = Array.isArray(showTimeRecord.seatPrices) ? showTimeRecord.seatPrices : [];
      const priceText = seatPrices.map(formatSeatPrice).filter((part) => part !== undefined).join(", ");

      lines.push(
        priceText
          ? `${datePrefix}${hall} ${time} (${priceText})`
          : `${datePrefix}${hall} ${String(time)}`,
      );
    }
  }

  return lines;
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/**
 * Opens (or fetches the existing) DM channel between the bot and the given Discord
 * user id. Returns the channel id to send messages to. Throws an Error including the
 * response status and body if Discord rejects the request (e.g. bad bot token, or the
 * bot and user don't share a server).
 */
async function openDmChannel(botToken: string, userId: string): Promise<string> {
  const response = await fetch(`${DISCORD_API_BASE_URL}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord open-DM-channel failed (${response.status}): ${body}`);
  }

  const channel = (await response.json()) as { readonly id: string };
  return channel.id;
}

/**
 * Sends a plain-text Discord DM to one user via the bot's REST API: opens the DM
 * channel, then posts the message into it. Returns nothing on success; throws an
 * Error including the response status and body on failure.
 */
async function sendDiscordMessageToUser(
  botToken: string,
  userId: string,
  content: string,
): Promise<void> {
  const channelId = await openDmChannel(botToken, userId);

  const response = await fetch(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord send-DM failed (${response.status}): ${body}`);
  }
}

/**
 * Sends the same plain-text Discord DM to every configured user id, independently —
 * one recipient's failure (e.g. they haven't shared a server with the bot) doesn't
 * block delivery to the others. Returns nothing if at least one recipient received
 * it; throws an aggregate Error only if every recipient's send failed, so callers can
 * still treat "delivered to nobody" as a failure worth retrying.
 */
export async function sendDiscordMessage(
  botToken: string,
  userIds: readonly string[],
  content: string,
): Promise<void> {
  const results = await Promise.allSettled(
    userIds.map((userId) => sendDiscordMessageToUser(botToken, userId, content)),
  );

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  for (const failure of failures) {
    log("error", "Failed to DM one recipient", { error: String(failure.reason) });
  }

  if (failures.length === results.length) {
    throw new Error(`Discord send-DM failed for all ${results.length} recipient(s)`);
  }
}
