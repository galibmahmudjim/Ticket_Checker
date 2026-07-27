import {
  getBotGuildIds,
  getBotGuildMember,
  getBotUserId,
  getGuild,
  getGuildChannels,
  type DiscordChannel,
} from "./discordRest.js";
import { canPostIn } from "./permissions.js";
import { registerGuildChannel, unregisterGuild, getRegisteredGuildIds } from "./channelStore.js";
import { log } from "./logger.js";

const CHANNEL_TYPE_GUILD_TEXT = 0;

let cachedBotUserId: string | undefined;

/**
 * Returns the bot's user id, fetched once per process instance and memoised — it never
 * changes for a given token, and guild sync would otherwise re-request it on every poll.
 */
async function resolveBotUserId(botToken: string): Promise<string> {
  cachedBotUserId ??= await getBotUserId(botToken);
  return cachedBotUserId;
}

/**
 * Picks the channel to post alerts in for one guild: the guild's system channel if the
 * bot can post there, otherwise the lowest-positioned text channel it has View Channel
 * and Send Messages in. Returns the channel id, or undefined when no channel is
 * postable (e.g. the bot was added without the required permissions).
 */
async function findTargetChannelId(
  botToken: string,
  guildId: string,
  botUserId: string,
): Promise<string | undefined> {
  const [guild, member, channels] = await Promise.all([
    getGuild(botToken, guildId),
    getBotGuildMember(botToken, guildId, botUserId),
    getGuildChannels(botToken, guildId),
  ]);

  const textChannels = channels
    .filter((channel): channel is DiscordChannel => channel.type === CHANNEL_TYPE_GUILD_TEXT)
    .sort((left, right) => left.position - right.position);

  const systemChannel = textChannels.find((channel) => channel.id === guild.system_channel_id);
  if (systemChannel && canPostIn(guild, member, systemChannel, botUserId)) {
    return systemChannel.id;
  }

  return textChannels.find((channel) => canPostIn(guild, member, channel, botUserId))?.id;
}

/**
 * Registers an alert channel for one guild. Never throws — logs and swallows failures
 * so one unreachable guild doesn't abort the whole sync. Returns the registered
 * channel id when this call registered a genuinely new guild, otherwise undefined.
 */
async function registerGuild(
  botToken: string,
  databaseUrl: string,
  guildId: string,
  botUserId: string,
): Promise<string | undefined> {
  try {
    const channelId = await findTargetChannelId(botToken, guildId, botUserId);
    if (!channelId) {
      log("warn", "No postable channel found for guild", { guildId });
      return undefined;
    }
    await registerGuildChannel(databaseUrl, guildId, channelId);
    return channelId;
  } catch (error) {
    log("error", "Failed to register guild channel", {
      guildId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Reconciles registered alert channels against the guilds the bot is actually in,
 * using Discord's REST API only — this replaces the Gateway's guildCreate/guildDelete
 * events, which cannot be received without a persistent WebSocket. Registers a channel
 * for guilds not yet in the database, and deletes registrations for guilds the bot has
 * been removed from so polls don't keep failing with "Unknown Channel". Returns the
 * channel ids registered by this call, so the caller can post to a brand-new server
 * immediately rather than leaving it silent. Never throws — a failed sync is logged and
 * the next poll retries.
 */
export async function syncGuilds(
  botToken: string,
  databaseUrl: string,
): Promise<readonly string[]> {
  try {
    const [currentGuildIds, registeredGuildIds] = await Promise.all([
      getBotGuildIds(botToken),
      getRegisteredGuildIds(databaseUrl),
    ]);

    const registered = new Set(registeredGuildIds);
    const current = new Set(currentGuildIds);

    await Promise.all(
      registeredGuildIds
        .filter((guildId) => !current.has(guildId))
        .map((guildId) =>
          unregisterGuild(databaseUrl, guildId).catch((error: unknown) =>
            log("error", "Failed to unregister guild channel", {
              guildId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
    );

    const newGuildIds = currentGuildIds.filter((guildId) => !registered.has(guildId));
    if (newGuildIds.length === 0) {
      return [];
    }

    const botUserId = await resolveBotUserId(botToken);
    const channelIds = await Promise.all(
      newGuildIds.map((guildId) => registerGuild(botToken, databaseUrl, guildId, botUserId)),
    );

    return channelIds.filter((channelId): channelId is string => channelId !== undefined);
  } catch (error) {
    log("error", "Guild sync failed; will retry next poll", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
