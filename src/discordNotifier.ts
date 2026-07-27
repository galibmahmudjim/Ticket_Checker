const COMMON_DATE_KEYS = ["date", "show_date", "showDate"] as const;
const COMMON_TIME_KEYS = ["time", "show_time", "showTime"] as const;
const COMMON_HALL_KEYS = ["location", "hall", "hall_name", "screen", "venue"] as const;

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

/**
 * Builds a human-readable one-line description of a single showdate/showtime entry
 * for use in a Discord message. Returns "date | time | Location N" when those fields
 * can be guessed from common field names, otherwise falls back to the entry's raw JSON.
 */
export function formatShowEntry(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) {
    return String(entry);
  }

  const record = entry as Record<string, unknown>;
  const location = firstDefined(record, COMMON_HALL_KEYS);
  const parts = [
    firstDefined(record, COMMON_DATE_KEYS),
    firstDefined(record, COMMON_TIME_KEYS),
    location !== undefined ? `Location ${location}` : undefined,
  ].filter((part) => part !== undefined);

  return parts.length > 0 ? parts.map(String).join(" | ") : JSON.stringify(record);
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
 * Sends a plain-text Discord DM to the configured user via the bot's REST API: opens
 * the DM channel, then posts the message into it. Returns nothing on success; throws
 * an Error including the response status and body on failure.
 */
export async function sendDiscordMessage(
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
