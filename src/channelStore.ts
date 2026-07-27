import type { Pool } from "pg";
import { getPool } from "./db.js";
import { log } from "./logger.js";

interface ChannelRow {
  readonly channel_id: string;
  readonly fingerprints: readonly string[];
  readonly has_polled_before: boolean;
}

export interface ChannelState {
  readonly channelId: string;
  readonly fingerprints: ReadonlySet<string>;
  readonly hasPolledBefore: boolean;
}

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the discord_channels table exists
 * first (once per process).
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS discord_channels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        fingerprints TEXT[] NOT NULL DEFAULT '{}',
        has_polled_before BOOLEAN NOT NULL DEFAULT false,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Registers the channel to post alerts in for a given guild. Idempotent — if the
 * guild is already registered (e.g. the bot rejoining a server it left), the
 * existing channel choice is kept rather than overwritten. Returns nothing; logs
 * when a genuinely new guild/channel is registered.
 */
export async function registerGuildChannel(
  databaseUrl: string,
  guildId: string,
  channelId: string,
): Promise<void> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    `INSERT INTO discord_channels (guild_id, channel_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO NOTHING
     RETURNING guild_id`,
    [guildId, channelId],
  );
  if (result.rows.length > 0) {
    log("info", "Registered new Discord alert channel", { guildId, channelId });
  }
}

/**
 * Returns every registered guild id, so callers can reconcile them against the
 * guilds the bot is actually in.
 */
export async function getRegisteredGuildIds(databaseUrl: string): Promise<readonly string[]> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ guild_id: string }>("SELECT guild_id FROM discord_channels");
  return result.rows.map((row) => row.guild_id);
}

/**
 * Removes a guild's registered channel, e.g. when the bot is removed from that
 * server — otherwise its channel row would linger and every poll would fail trying
 * to post somewhere the bot can no longer reach. Returns nothing; logs if a row was
 * actually removed.
 */
export async function unregisterGuild(databaseUrl: string, guildId: string): Promise<void> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    "DELETE FROM discord_channels WHERE guild_id = $1 RETURNING channel_id",
    [guildId],
  );
  if (result.rows.length > 0) {
    log("info", "Unregistered Discord alert channel", { guildId });
  }
}

/**
 * Returns every registered guild's alert channel id.
 */
export async function getChannelIds(databaseUrl: string): Promise<readonly string[]> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ channel_id: string }>("SELECT channel_id FROM discord_channels");
  return result.rows.map((row) => row.channel_id);
}

/**
 * Returns every registered channel with its own fingerprint/baseline tracking
 * state, so new-vs-already-seen detection can be computed independently per
 * channel — a channel that just joined hasn't "seen" any sessions yet, so it gets
 * its own first-poll baseline instead of silently inheriting other channels' history.
 */
export async function getChannelStates(databaseUrl: string): Promise<readonly ChannelState[]> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<ChannelRow>(
    "SELECT channel_id, fingerprints, has_polled_before FROM discord_channels",
  );
  return result.rows.map((row) => ({
    channelId: row.channel_id,
    fingerprints: new Set(row.fingerprints),
    hasPolledBefore: row.has_polled_before,
  }));
}

/**
 * Returns one channel's tracking state by channel id, or undefined if it isn't
 * registered (e.g. the bot was removed from that server in between).
 */
export async function getChannelState(
  databaseUrl: string,
  channelId: string,
): Promise<ChannelState | undefined> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<ChannelRow>(
    "SELECT channel_id, fingerprints, has_polled_before FROM discord_channels WHERE channel_id = $1",
    [channelId],
  );
  const row = result.rows[0];
  return row
    ? {
        channelId: row.channel_id,
        fingerprints: new Set(row.fingerprints),
        hasPolledBefore: row.has_polled_before,
      }
    : undefined;
}

/**
 * Upserts one channel's fingerprint/baseline tracking state after a poll. Returns
 * nothing; this becomes the new baseline for that channel's next poll.
 */
export async function saveChannelState(databaseUrl: string, state: ChannelState): Promise<void> {
  const db = await ensureTable(databaseUrl);
  await db.query(
    `UPDATE discord_channels SET fingerprints = $2, has_polled_before = true WHERE channel_id = $1`,
    [state.channelId, [...state.fingerprints]],
  );
}
