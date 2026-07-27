import "dotenv/config";
import assert from "node:assert/strict";
import {
  getBotGuildIds,
  getBotGuildMember,
  getBotUserId,
  getGuild,
  getGuildChannels,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMember,
} from "../src/discordRest.js";
import { canPostIn } from "../src/permissions.js";
import { closePool, getPool } from "../src/db.js";

const CHANNEL_TYPE_GUILD_TEXT = 0;

/**
 * Verifies that the REST-only channel picker chooses the same channel the removed
 * discord.js Gateway implementation chose, by recomputing the target channel for every
 * guild the bot is in and comparing it against the rows already registered in
 * discord_channels. Because those rows were written by the Gateway version, a match is
 * direct evidence that src/permissions.ts reproduces discord.js's `permissionsFor`
 * resolution correctly.
 *
 * Read-only: performs no registration or pruning. Requires DISCORD_BOT_TOKEN and
 * DATABASE_URL. Run with: npx tsx test/guildSync.channelSelection.test.ts
 */
async function main(): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(botToken, "DISCORD_BOT_TOKEN must be set to run this test");
  assert.ok(databaseUrl, "DATABASE_URL must be set to run this test");

  const botUserId = await getBotUserId(botToken);
  const guildIds = await getBotGuildIds(botToken);
  console.log(`bot ${botUserId} is in ${guildIds.length} guild(s)`);
  assert.ok(guildIds.length > 0, "bot must be in at least one guild to validate selection");

  const existing = await getPool(databaseUrl).query<{ guild_id: string; channel_id: string }>(
    "SELECT guild_id, channel_id FROM discord_channels",
  );
  const registeredByGuild = new Map(existing.rows.map((row) => [row.guild_id, row.channel_id]));

  let compared = 0;
  for (const guildId of guildIds) {
    const guild: DiscordGuild = await getGuild(botToken, guildId);
    const member: DiscordMember = await getBotGuildMember(botToken, guildId, botUserId);
    const channels: readonly DiscordChannel[] = await getGuildChannels(botToken, guildId);

    const textChannels = channels
      .filter((channel) => channel.type === CHANNEL_TYPE_GUILD_TEXT)
      .sort((left, right) => left.position - right.position);

    const postable = textChannels.filter((channel) => canPostIn(guild, member, channel, botUserId));
    const systemChannel = postable.find((channel) => channel.id === guild.system_channel_id);
    const chosen = (systemChannel ?? postable[0])?.id;

    console.log(
      `guild ${guildId}: ${textChannels.length} text channel(s), ${postable.length} postable, chose ${chosen ?? "none"}`,
    );

    assert.ok(chosen, `no postable channel computed for guild ${guildId}`);

    const previouslyRegistered = registeredByGuild.get(guildId);
    if (previouslyRegistered) {
      assert.equal(
        chosen,
        previouslyRegistered,
        `REST picker chose ${chosen} but the Gateway version had registered ${previouslyRegistered} for guild ${guildId}`,
      );
      compared += 1;
    }
  }

  await closePool();
  console.log(`guildSync channel selection: all assertions passed (${compared} matched prior registration)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
