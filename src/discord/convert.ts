/**
 * Pure Discord helpers: snowflakes, permission bit sets, channel types, CDN URLs
 * and markdown. No network; everything here is unit-tested directly.
 */

/** Milliseconds between the Unix epoch and the Discord epoch (2015-01-01T00:00:00Z). */
export const DISCORD_EPOCH_MS = 1_420_070_400_000n;

const SNOWFLAKE_RE = /^\d{1,20}$/;

/** Parse a snowflake id string (or bigint) into a bigint; null if it is not a valid unsigned 64-bit integer. */
export function parseSnowflake(id: string | bigint | number | null | undefined): bigint | null {
  if (id == null) return null;
  if (typeof id === "bigint") return id >= 0n && id < 1n << 64n ? id : null;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : null;
  const trimmed = id.trim();
  if (!SNOWFLAKE_RE.test(trimmed)) return null;
  const value = BigInt(trimmed);
  return value < 1n << 64n ? value : null;
}

/** Creation time of a snowflake in Unix milliseconds, or null for an invalid id. */
export function snowflakeToMillis(id: string | bigint | number | null | undefined): number | null {
  const value = parseSnowflake(id);
  return value == null ? null : Number((value >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake created at `ms` (use as an `after`/`before` cursor). */
export function millisToSnowflake(ms: number | bigint): string {
  const delta = BigInt(ms) - DISCORD_EPOCH_MS;
  return (delta <= 0n ? 0n : delta << 22n).toString();
}

export interface SnowflakeParts {
  created_at: number;
  worker_id: number;
  process_id: number;
  increment: number;
}

/** Split a snowflake into its timestamp, internal worker id, process id and increment. */
export function snowflakeParts(id: string | bigint | number | null | undefined): SnowflakeParts | null {
  const value = parseSnowflake(id);
  if (value == null) return null;
  return {
    created_at: Number((value >> 22n) + DISCORD_EPOCH_MS),
    worker_id: Number((value >> 17n) & 0x1fn),
    process_id: Number((value >> 12n) & 0x1fn),
    increment: Number(value & 0xfffn),
  };
}

/** Compare two snowflake strings numerically. */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Discord permission flags, by bit position. https://discord.com/developers/docs/topics/permissions */
export const PERMISSION_FLAGS: readonly { name: string; bit: number; description: string }[] = [
  { name: "CREATE_INSTANT_INVITE", bit: 0, description: "Create instant invites" },
  { name: "KICK_MEMBERS", bit: 1, description: "Kick members" },
  { name: "BAN_MEMBERS", bit: 2, description: "Ban members" },
  { name: "ADMINISTRATOR", bit: 3, description: "All permissions; bypasses channel overwrites" },
  { name: "MANAGE_CHANNELS", bit: 4, description: "Manage and edit channels" },
  { name: "MANAGE_GUILD", bit: 5, description: "Manage and edit the guild" },
  { name: "ADD_REACTIONS", bit: 6, description: "Add new reactions to messages" },
  { name: "VIEW_AUDIT_LOG", bit: 7, description: "View the audit log" },
  { name: "PRIORITY_SPEAKER", bit: 8, description: "Use priority speaker in voice channels" },
  { name: "STREAM", bit: 9, description: "Go live / stream video" },
  { name: "VIEW_CHANNEL", bit: 10, description: "View a channel, read messages in text channels" },
  { name: "SEND_MESSAGES", bit: 11, description: "Send messages and create threads in forums" },
  { name: "SEND_TTS_MESSAGES", bit: 12, description: "Send text-to-speech messages" },
  { name: "MANAGE_MESSAGES", bit: 13, description: "Delete other users' messages" },
  { name: "EMBED_LINKS", bit: 14, description: "Links sent are auto-embedded" },
  { name: "ATTACH_FILES", bit: 15, description: "Upload images and files" },
  { name: "READ_MESSAGE_HISTORY", bit: 16, description: "Read message history" },
  { name: "MENTION_EVERYONE", bit: 17, description: "Use @everyone, @here and mention all roles" },
  { name: "USE_EXTERNAL_EMOJIS", bit: 18, description: "Use emojis from other guilds" },
  { name: "VIEW_GUILD_INSIGHTS", bit: 19, description: "View guild insights" },
  { name: "CONNECT", bit: 20, description: "Join a voice channel" },
  { name: "SPEAK", bit: 21, description: "Speak in a voice channel" },
  { name: "MUTE_MEMBERS", bit: 22, description: "Mute members in voice" },
  { name: "DEAFEN_MEMBERS", bit: 23, description: "Deafen members in voice" },
  { name: "MOVE_MEMBERS", bit: 24, description: "Move members between voice channels" },
  { name: "USE_VAD", bit: 25, description: "Use voice activity detection" },
  { name: "CHANGE_NICKNAME", bit: 26, description: "Change own nickname" },
  { name: "MANAGE_NICKNAMES", bit: 27, description: "Change other members' nicknames" },
  { name: "MANAGE_ROLES", bit: 28, description: "Manage and edit roles" },
  { name: "MANAGE_WEBHOOKS", bit: 29, description: "Manage and edit webhooks" },
  { name: "MANAGE_GUILD_EXPRESSIONS", bit: 30, description: "Edit and delete emojis, stickers and sounds" },
  { name: "USE_APPLICATION_COMMANDS", bit: 31, description: "Use application commands" },
  { name: "REQUEST_TO_SPEAK", bit: 32, description: "Request to speak in stage channels" },
  { name: "MANAGE_EVENTS", bit: 33, description: "Edit and delete scheduled events" },
  { name: "MANAGE_THREADS", bit: 34, description: "Delete, archive and view all threads" },
  { name: "CREATE_PUBLIC_THREADS", bit: 35, description: "Create public and announcement threads" },
  { name: "CREATE_PRIVATE_THREADS", bit: 36, description: "Create private threads" },
  { name: "USE_EXTERNAL_STICKERS", bit: 37, description: "Use stickers from other guilds" },
  { name: "SEND_MESSAGES_IN_THREADS", bit: 38, description: "Send messages in threads" },
  { name: "USE_EMBEDDED_ACTIVITIES", bit: 39, description: "Use activities in voice channels" },
  { name: "MODERATE_MEMBERS", bit: 40, description: "Time out members" },
  { name: "VIEW_CREATOR_MONETIZATION_ANALYTICS", bit: 41, description: "View role subscription insights" },
  { name: "USE_SOUNDBOARD", bit: 42, description: "Use the soundboard in voice" },
  { name: "CREATE_GUILD_EXPRESSIONS", bit: 43, description: "Create emojis, stickers and sounds" },
  { name: "CREATE_EVENTS", bit: 44, description: "Create scheduled events" },
  { name: "USE_EXTERNAL_SOUNDS", bit: 45, description: "Use soundboard sounds from other guilds" },
  { name: "SEND_VOICE_MESSAGES", bit: 46, description: "Send voice messages" },
  { name: "SEND_POLLS", bit: 49, description: "Send polls" },
  { name: "USE_EXTERNAL_APPS", bit: 50, description: "Use user-installed apps in the guild" },
  { name: "PIN_MESSAGES", bit: 51, description: "Pin and unpin messages" },
  { name: "BYPASS_SLOWMODE", bit: 52, description: "Bypass slowmode restrictions" },
];

const FLAG_BY_NAME = new Map(PERMISSION_FLAGS.map((f) => [f.name, f]));

/** Parse a permission bit set (Discord sends it as a decimal string). Null for invalid input. */
export function parsePermissions(value: string | bigint | number | null | undefined): bigint | null {
  return parseSnowflake(value);
}

/** Names of the flags set in a permission bit set, in bit order. */
export function permissionNames(value: string | bigint | number | null | undefined): string[] | null {
  const bits = parsePermissions(value);
  if (bits == null) return null;
  return PERMISSION_FLAGS.filter((f) => (bits >> BigInt(f.bit)) & 1n).map((f) => f.name);
}

/**
 * Whether a permission bit set includes the named flag (case-insensitive).
 * Null for invalid input; throws for an unknown flag name.
 */
export function hasPermission(value: string | bigint | number | null | undefined, name: string): boolean | null {
  const bits = parsePermissions(value);
  if (bits == null) return null;
  const flag = FLAG_BY_NAME.get(name.trim().toUpperCase());
  if (!flag) throw new Error(`unknown Discord permission '${name}'; see discord.main.permission_flags`);
  return ((bits >> BigInt(flag.bit)) & 1n) === 1n;
}

/** Discord channel types. https://discord.com/developers/docs/resources/channel#channel-object-channel-types */
export const CHANNEL_TYPES: readonly { type: number; name: string; description: string }[] = [
  { type: 0, name: "GUILD_TEXT", description: "A text channel within a guild" },
  { type: 1, name: "DM", description: "A direct message between users" },
  { type: 2, name: "GUILD_VOICE", description: "A voice channel within a guild" },
  { type: 3, name: "GROUP_DM", description: "A direct message between multiple users" },
  { type: 4, name: "GUILD_CATEGORY", description: "A category that contains up to 50 channels" },
  { type: 5, name: "GUILD_ANNOUNCEMENT", description: "A channel users can follow and crosspost" },
  { type: 10, name: "ANNOUNCEMENT_THREAD", description: "A thread within an announcement channel" },
  { type: 11, name: "PUBLIC_THREAD", description: "A public thread within a text or forum channel" },
  { type: 12, name: "PRIVATE_THREAD", description: "A private thread within a text channel" },
  { type: 13, name: "GUILD_STAGE_VOICE", description: "A voice channel for hosting events with an audience" },
  { type: 14, name: "GUILD_DIRECTORY", description: "The channel in a hub listing guilds" },
  { type: 15, name: "GUILD_FORUM", description: "A channel that can only contain threads" },
  { type: 16, name: "GUILD_MEDIA", description: "A channel that can only contain media threads" },
];

const CHANNEL_TYPE_NAMES = new Map(CHANNEL_TYPES.map((c) => [c.type, c.name]));

/** Name of a channel type number, e.g. 0 -> 'GUILD_TEXT'; null when unknown. */
export function channelTypeName(type: number | null | undefined): string | null {
  return type == null ? null : (CHANNEL_TYPE_NAMES.get(type) ?? null);
}

export const TIMESTAMP_STYLES = ["t", "T", "d", "D", "f", "F", "R"] as const;
export type TimestampStyle = (typeof TIMESTAMP_STYLES)[number];

/** Discord's `<t:unix:style>` markup, rendered in each viewer's local time zone. */
export function timestampMarkdown(ms: number | null, style: TimestampStyle = "f"): string | null {
  if (ms == null) return null;
  const seconds = Math.floor(ms / 1000);
  return style === "f" ? `<t:${seconds}>` : `<t:${seconds}:${style}>`;
}

/** Escape Discord markdown so text renders literally. */
export function escapeMarkdown(text: string | null): string | null {
  if (text == null) return null;
  return text.replace(/[\\*_~`|>[\]()]/g, "\\$&").replace(/^([#-])/gm, "\\$1");
}

/** `<@id>`, `<#id>` or `<@&id>`; null for an invalid id. */
export function mention(kind: "user" | "channel" | "role", id: string | null): string | null {
  if (parseSnowflake(id) == null) return null;
  const clean = (id as string).trim();
  return kind === "user" ? `<@${clean}>` : kind === "channel" ? `<#${clean}>` : `<@&${clean}>`;
}

/** A clickable link to a message. `guildId` NULL means a DM (`@me`). */
export function messageUrl(guildId: string | null, channelId: string | null, messageId: string | null): string | null {
  if (channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

/** CDN URL of a user's avatar; the default avatar when `hash` is NULL. */
export function avatarUrl(userId: string | null, hash: string | null): string | null {
  const id = parseSnowflake(userId);
  if (id == null) return null;
  if (hash == null || hash === "") return `https://cdn.discordapp.com/embed/avatars/${(id >> 22n) % 6n}.png`;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}`;
}

/** Convert an ISO-8601 timestamp to Unix milliseconds; null when missing or unparsable. */
export function isoToMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** `#rrggbb` for an integer color; null for 0 (Discord's "no color"). */
export function colorHex(color: number | null | undefined): string | null {
  if (!color) return null;
  return `#${color.toString(16).padStart(6, "0")}`;
}
