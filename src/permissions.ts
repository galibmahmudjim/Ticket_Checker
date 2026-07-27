import type { DiscordChannel, DiscordGuild, DiscordMember } from "./discordRest.js";

const PERMISSION_ADMINISTRATOR = 1n << 3n;
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_SEND_MESSAGES = 1n << 11n;

const OVERWRITE_TYPE_ROLE = 0;
const OVERWRITE_TYPE_MEMBER = 1;

/**
 * Computes the bot's effective permission bits in one channel, following Discord's
 * documented resolution order: union of @everyone and the bot's role permissions,
 * short-circuited by Administrator, then the @everyone channel overwrite, then the
 * union of its role overwrites, then its member-specific overwrite. Returns the
 * resulting bitfield. This reimplements what discord.js's `permissionsFor` did before
 * the Gateway was removed, since the REST channel payload carries raw overwrites only.
 */
function computeChannelPermissions(
  guild: DiscordGuild,
  member: DiscordMember,
  channel: DiscordChannel,
  botUserId: string,
): bigint {
  const rolesById = new Map(guild.roles.map((role) => [role.id, role]));
  const everyoneRole = rolesById.get(guild.id);

  let permissions = everyoneRole ? BigInt(everyoneRole.permissions) : 0n;
  for (const roleId of member.roles) {
    const role = rolesById.get(roleId);
    if (role) {
      permissions |= BigInt(role.permissions);
    }
  }

  if ((permissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) {
    return ~0n;
  }

  const overwrites = channel.permission_overwrites ?? [];

  const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === guild.id);
  if (everyoneOverwrite) {
    permissions &= ~BigInt(everyoneOverwrite.deny);
    permissions |= BigInt(everyoneOverwrite.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === OVERWRITE_TYPE_ROLE && member.roles.includes(overwrite.id)) {
      roleAllow |= BigInt(overwrite.allow);
      roleDeny |= BigInt(overwrite.deny);
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === OVERWRITE_TYPE_MEMBER && overwrite.id === botUserId,
  );
  if (memberOverwrite) {
    permissions &= ~BigInt(memberOverwrite.deny);
    permissions |= BigInt(memberOverwrite.allow);
  }

  return permissions;
}

/**
 * Reports whether the bot can both see and post in a channel, the two permissions the
 * OAuth invite asks for. Returns true only when View Channel and Send Messages both
 * survive permission resolution, so a channel that would 403 on the first alert is
 * never registered.
 */
export function canPostIn(
  guild: DiscordGuild,
  member: DiscordMember,
  channel: DiscordChannel,
  botUserId: string,
): boolean {
  const permissions = computeChannelPermissions(guild, member, channel, botUserId);
  const required = PERMISSION_VIEW_CHANNEL | PERMISSION_SEND_MESSAGES;
  return (permissions & required) === required;
}
