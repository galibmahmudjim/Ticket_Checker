import type { Pool } from "pg";
import { getPool } from "./db.js";
import { log } from "./logger.js";

let tableEnsured = false;

/**
 * Returns the shared connection pool, ensuring the discord_recipients table exists
 * first (once per process).
 */
async function ensureTable(databaseUrl: string): Promise<Pool> {
  const db = getPool(databaseUrl);
  if (!tableEnsured) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS discord_recipients (
        user_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    tableEnsured = true;
  }
  return db;
}

/**
 * Registers a Discord user id as an alert recipient, associated with the guild that
 * caused them to be added (its owner). Idempotent — re-registering an existing
 * recipient (e.g. the bot rejoining a server it left, or the same person owning
 * multiple servers the bot is in) is a no-op. Returns nothing; logs when a genuinely
 * new recipient is added.
 */
export async function addRecipient(
  databaseUrl: string,
  userId: string,
  guildId: string,
): Promise<void> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query(
    `INSERT INTO discord_recipients (user_id, guild_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [userId, guildId],
  );
  if (result.rows.length > 0) {
    log("info", "Registered new Discord alert recipient", { userId, guildId });
  }
}

/**
 * Returns every registered recipient's Discord user id.
 */
export async function getRecipients(databaseUrl: string): Promise<readonly string[]> {
  const db = await ensureTable(databaseUrl);
  const result = await db.query<{ user_id: string }>("SELECT user_id FROM discord_recipients");
  return result.rows.map((row) => row.user_id);
}
