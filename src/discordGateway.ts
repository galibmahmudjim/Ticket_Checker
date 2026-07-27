import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionsBitField,
  type Guild,
  type TextChannel,
} from "discord.js";
import { registerGuildChannel } from "./channelStore.js";
import { log } from "./logger.js";

/**
 * Picks the channel to post alerts in for a guild: the guild's system channel if the
 * bot can post there, otherwise the first text channel it has Send Messages
 * permission in. Returns undefined if no postable channel is found (e.g. the bot has
 * no channel permissions yet).
 */
function findTargetChannel(guild: Guild): TextChannel | undefined {
  const me = guild.members.me;
  if (!me) {
    return undefined;
  }

  const canPost = (channel: TextChannel): boolean =>
    channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages) ?? false;

  if (guild.systemChannel && canPost(guild.systemChannel)) {
    return guild.systemChannel;
  }

  return guild.channels.cache.find(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText && canPost(channel),
  );
}

/**
 * Finds and registers the alert channel for one guild. Never throws — logs and
 * swallows failures so one bad registration doesn't take down the gateway
 * connection.
 */
async function registerGuild(databaseUrl: string, guild: Guild): Promise<void> {
  try {
    const channel = findTargetChannel(guild);
    if (!channel) {
      log("warn", "No postable channel found for guild", { guildId: guild.id });
      return;
    }
    await registerGuildChannel(databaseUrl, guild.id, channel.id);
  } catch (error) {
    log("error", "Failed to register guild channel", {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Connects to Discord's Gateway and keeps a persistent client alive so the bot can
 * detect which servers it's a member of. Registers a channel to post alerts in for
 * each guild in Postgres — both for guilds already joined at startup (checked once
 * the client is ready, since discord.js populates those into cache directly without
 * emitting an event per guild) and for guilds joined afterward (via the guildCreate
 * event, which only fires for genuinely new joins). Returns the connected Client once
 * ready and initial guilds are registered, so the caller can safely look up channels
 * immediately after, and destroy the client on shutdown.
 */
export async function startDiscordGateway(botToken: string, databaseUrl: string): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.GuildCreate, (guild) => {
    void registerGuild(databaseUrl, guild);
  });

  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (readyClient) => {
      log("info", "Discord gateway connected", { user: readyClient.user.tag });
      Promise.all([...readyClient.guilds.cache.values()].map((guild) => registerGuild(databaseUrl, guild)))
        .catch((error: unknown) =>
          log("error", "Failed to register existing guild channels", { error: String(error) }),
        )
        .finally(resolve);
    });
  });

  await client.login(botToken);
  await ready;
  return client;
}
