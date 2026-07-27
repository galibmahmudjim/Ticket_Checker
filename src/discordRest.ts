const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export interface DiscordRole {
  readonly id: string;
  readonly permissions: string;
}

export interface DiscordOverwrite {
  readonly id: string;
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export interface DiscordChannel {
  readonly id: string;
  readonly type: number;
  readonly position: number;
  readonly permission_overwrites?: readonly DiscordOverwrite[];
}

export interface DiscordGuild {
  readonly id: string;
  readonly roles: readonly DiscordRole[];
  readonly system_channel_id: string | null;
}

export interface DiscordMember {
  readonly roles: readonly string[];
}

/**
 * Performs one authenticated GET against the Discord REST API as the bot. Retries
 * once on a 429 after honouring the `retry_after` hint, since guild sync runs on
 * every poll and a burst of channel lookups can hit a bucket limit. Returns the
 * parsed JSON body typed as T. Throws an Error carrying the status and body on any
 * non-2xx response.
 */
async function discordGet<T>(botToken: string, path: string): Promise<T> {
  const request = async (): Promise<Response> =>
    fetch(`${DISCORD_API_BASE_URL}${path}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

  let response = await request();

  if (response.status === 429) {
    const retry = (await response.json().catch(() => ({}))) as { retry_after?: number };
    await new Promise((resolve) => setTimeout(resolve, Math.ceil((retry.retry_after ?? 1) * 1000)));
    response = await request();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord GET ${path} failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

/**
 * Returns the bot's own user id, needed to look up its guild member record and to
 * match member-specific channel permission overwrites.
 */
export async function getBotUserId(botToken: string): Promise<string> {
  const user = await discordGet<{ id: string }>(botToken, "/users/@me");
  return user.id;
}

/**
 * Returns the ids of every guild the bot is currently a member of. This replaces the
 * Gateway's guild cache: it is the authoritative membership list used both to
 * register newly joined servers and to prune ones the bot was removed from.
 */
export async function getBotGuildIds(botToken: string): Promise<readonly string[]> {
  const guilds = await discordGet<readonly { id: string }[]>(botToken, "/users/@me/guilds");
  return guilds.map((guild) => guild.id);
}

/**
 * Returns one guild with its full role list and system channel id, which together
 * supply the base permissions used when picking a channel to post alerts in.
 */
export async function getGuild(botToken: string, guildId: string): Promise<DiscordGuild> {
  return discordGet<DiscordGuild>(botToken, `/guilds/${guildId}`);
}

/**
 * Returns the bot's own member record in a guild, whose role ids determine which role
 * permissions and which channel overwrites apply to it.
 */
export async function getBotGuildMember(
  botToken: string,
  guildId: string,
  botUserId: string,
): Promise<DiscordMember> {
  return discordGet<DiscordMember>(botToken, `/guilds/${guildId}/members/${botUserId}`);
}

/**
 * Returns every channel in a guild, including each channel's permission overwrites,
 * so a postable one can be chosen without a Gateway connection.
 */
export async function getGuildChannels(
  botToken: string,
  guildId: string,
): Promise<readonly DiscordChannel[]> {
  return discordGet<readonly DiscordChannel[]>(botToken, `/guilds/${guildId}/channels`);
}
