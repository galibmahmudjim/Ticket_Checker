import { Client, GatewayIntentBits, Events, type Guild } from "discord.js";
import { addRecipient } from "./recipientStore.js";
import { log } from "./logger.js";

/**
 * Registers guild.ownerId as an alert recipient. Never throws — logs and swallows
 * failures so one bad registration doesn't take down the gateway connection.
 */
async function registerGuildOwner(databaseUrl: string, guild: Guild): Promise<void> {
  try {
    await addRecipient(databaseUrl, guild.ownerId, guild.id);
  } catch (error) {
    log("error", "Failed to register guild owner as recipient", {
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Connects to Discord's Gateway and keeps a persistent client alive so the bot can
 * detect which servers it's a member of. Registers each guild's owner as an alert
 * recipient in Postgres — both for guilds already joined at startup (checked once
 * the client is ready, since discord.js populates those into cache directly without
 * emitting an event per guild) and for guilds joined afterward (via the guildCreate
 * event, which only fires for genuinely new joins). Returns the connected Client once
 * ready and initial guilds are registered, so the caller can safely look up
 * recipients immediately after, and destroy the client on shutdown.
 */
export async function startDiscordGateway(botToken: string, databaseUrl: string): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.GuildCreate, (guild) => {
    void registerGuildOwner(databaseUrl, guild);
  });

  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (readyClient) => {
      log("info", "Discord gateway connected", { user: readyClient.user.tag });
      Promise.all(
        [...readyClient.guilds.cache.values()].map((guild) => registerGuildOwner(databaseUrl, guild)),
      )
        .catch((error: unknown) =>
          log("error", "Failed to register existing guild owners", { error: String(error) }),
        )
        .finally(resolve);
    });
  });

  await client.login(botToken);
  await ready;
  return client;
}
