import type { Pool } from "pg";
import { getPool } from "./db.js";
import { log } from "./logger.js";

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
 * Returns every registered guild's alert channel id.
 */
export async function getChannelIds(databaseUrl: string): Promise<readonly string[]> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ channel_id: string }>("SELECT channel_id FROM discord_channels");
  return result.rows.map((row) => row.channel_id);
}
