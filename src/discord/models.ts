/**
 * Discord JSON objects -> typed rows. Each model has its column list (the SQL
 * contract) and a mapper. Ids stay VARCHAR, as Discord serializes them;
 * timestamps become TIMESTAMP WITH TIME ZONE.
 */

import { channelTypeName, colorHex, isoToMillis, snowflakeToMillis } from "./convert.ts";
import type { ColumnSpec, Row } from "./table.ts";

// biome-ignore lint/suspicious/noExplicitAny: Discord JSON is loosely shaped; mappers coerce every field.
type Json = any;

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const boolOr = (v: unknown, fallback: boolean | null = null): boolean | null => (typeof v === "boolean" ? v : fallback);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

// ------------------------------------------------------------------ users

export const USER_COLUMNS: readonly ColumnSpec[] = [
  { name: "user_id", type: "VARCHAR", doc: "User snowflake id.", nullable: false },
  { name: "username", type: "VARCHAR", doc: "Unique username." },
  { name: "global_name", type: "VARCHAR", doc: "Display name, if set." },
  { name: "discriminator", type: "VARCHAR", doc: "Legacy 4-digit tag ('0' for migrated users)." },
  { name: "is_bot", type: "BOOLEAN", doc: "True for bot accounts." },
  { name: "avatar", type: "VARCHAR", doc: "Avatar hash; pass to avatar_url() for a link." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Account creation time, from the snowflake." },
];

export function mapUser(u: Json): Row {
  return {
    user_id: str(u.id),
    username: str(u.username),
    global_name: str(u.global_name),
    discriminator: str(u.discriminator),
    is_bot: boolOr(u.bot, false),
    avatar: str(u.avatar),
    created_at: snowflakeToMillis(u.id),
  };
}

// ------------------------------------------------------------------ guilds

export const GUILD_COLUMNS: readonly ColumnSpec[] = [
  { name: "guild_id", type: "VARCHAR", doc: "Guild (server) snowflake id.", nullable: false },
  { name: "name", type: "VARCHAR", doc: "Guild name." },
  { name: "icon", type: "VARCHAR", doc: "Icon hash." },
  { name: "is_owner", type: "BOOLEAN", doc: "True when the bot owns the guild." },
  { name: "permissions", type: "VARCHAR", doc: "The bot's permission bit set in the guild (decimal string)." },
  { name: "features", type: "VARCHAR[]", doc: "Enabled guild feature flags, e.g. COMMUNITY." },
  { name: "approximate_member_count", type: "INTEGER", doc: "Approximate number of members." },
  { name: "approximate_presence_count", type: "INTEGER", doc: "Approximate number of online members." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Guild creation time, from the snowflake." },
];

export function mapGuild(g: Json): Row {
  return {
    guild_id: str(g.id),
    name: str(g.name),
    icon: str(g.icon),
    is_owner: boolOr(g.owner),
    permissions: str(g.permissions),
    features: strList(g.features),
    approximate_member_count: num(g.approximate_member_count),
    approximate_presence_count: num(g.approximate_presence_count),
    created_at: snowflakeToMillis(g.id),
  };
}

export const GUILD_DETAIL_COLUMNS: readonly ColumnSpec[] = [
  { name: "guild_id", type: "VARCHAR", doc: "Guild (server) snowflake id.", nullable: false },
  { name: "name", type: "VARCHAR", doc: "Guild name." },
  { name: "description", type: "VARCHAR", doc: "Guild description (community guilds)." },
  { name: "owner_id", type: "VARCHAR", doc: "User id of the guild owner." },
  { name: "icon", type: "VARCHAR", doc: "Icon hash." },
  { name: "verification_level", type: "INTEGER", doc: "0 none, 1 low, 2 medium, 3 high, 4 very high." },
  { name: "explicit_content_filter", type: "INTEGER", doc: "0 disabled, 1 members without roles, 2 all members." },
  { name: "mfa_level", type: "INTEGER", doc: "1 when moderators need two-factor auth." },
  { name: "nsfw_level", type: "INTEGER", doc: "0 default, 1 explicit, 2 safe, 3 age restricted." },
  { name: "premium_tier", type: "INTEGER", doc: "Server boost level, 0-3." },
  { name: "premium_subscription_count", type: "INTEGER", doc: "Number of boosts." },
  { name: "preferred_locale", type: "VARCHAR", doc: "Preferred locale, e.g. en-US." },
  { name: "vanity_url_code", type: "VARCHAR", doc: "Vanity invite code, if any." },
  { name: "afk_channel_id", type: "VARCHAR", doc: "AFK voice channel id." },
  { name: "system_channel_id", type: "VARCHAR", doc: "Channel for system messages (joins, boosts)." },
  { name: "rules_channel_id", type: "VARCHAR", doc: "Rules channel id (community guilds)." },
  { name: "features", type: "VARCHAR[]", doc: "Enabled guild feature flags." },
  { name: "approximate_member_count", type: "INTEGER", doc: "Approximate number of members." },
  { name: "approximate_presence_count", type: "INTEGER", doc: "Approximate number of online members." },
  { name: "max_members", type: "INTEGER", doc: "Maximum number of members." },
  { name: "role_count", type: "INTEGER", doc: "Number of roles, including @everyone." },
  { name: "emoji_count", type: "INTEGER", doc: "Number of custom emojis." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Guild creation time, from the snowflake." },
];

export function mapGuildDetail(g: Json): Row {
  return {
    guild_id: str(g.id),
    name: str(g.name),
    description: str(g.description),
    owner_id: str(g.owner_id),
    icon: str(g.icon),
    verification_level: num(g.verification_level),
    explicit_content_filter: num(g.explicit_content_filter),
    mfa_level: num(g.mfa_level),
    nsfw_level: num(g.nsfw_level),
    premium_tier: num(g.premium_tier),
    premium_subscription_count: num(g.premium_subscription_count),
    preferred_locale: str(g.preferred_locale),
    vanity_url_code: str(g.vanity_url_code),
    afk_channel_id: str(g.afk_channel_id),
    system_channel_id: str(g.system_channel_id),
    rules_channel_id: str(g.rules_channel_id),
    features: strList(g.features),
    approximate_member_count: num(g.approximate_member_count),
    approximate_presence_count: num(g.approximate_presence_count),
    max_members: num(g.max_members),
    role_count: Array.isArray(g.roles) ? g.roles.length : null,
    emoji_count: Array.isArray(g.emojis) ? g.emojis.length : null,
    created_at: snowflakeToMillis(g.id),
  };
}

// ------------------------------------------------------------------ channels

export const CHANNEL_COLUMNS: readonly ColumnSpec[] = [
  { name: "channel_id", type: "VARCHAR", doc: "Channel snowflake id.", nullable: false },
  { name: "guild_id", type: "VARCHAR", doc: "Guild the channel belongs to." },
  { name: "name", type: "VARCHAR", doc: "Channel name." },
  { name: "type", type: "INTEGER", doc: "Channel type number (see the channel_types table)." },
  { name: "type_name", type: "VARCHAR", doc: "Channel type name, e.g. GUILD_TEXT, GUILD_VOICE." },
  { name: "position", type: "INTEGER", doc: "Sort position in the channel list." },
  { name: "parent_id", type: "VARCHAR", doc: "Category id (or parent channel id for threads)." },
  { name: "topic", type: "VARCHAR", doc: "Channel topic." },
  { name: "nsfw", type: "BOOLEAN", doc: "True for age-restricted channels." },
  { name: "last_message_id", type: "VARCHAR", doc: "Id of the most recent message (may point to a deleted one)." },
  { name: "rate_limit_per_user", type: "INTEGER", doc: "Slowmode delay in seconds (0 = off)." },
  { name: "bitrate", type: "INTEGER", doc: "Voice bitrate in bits per second." },
  { name: "user_limit", type: "INTEGER", doc: "Voice user limit (0 = unlimited)." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Channel creation time, from the snowflake." },
];

export function mapChannel(c: Json): Row {
  return {
    channel_id: str(c.id),
    guild_id: str(c.guild_id),
    name: str(c.name),
    type: num(c.type),
    type_name: channelTypeName(num(c.type)),
    position: num(c.position),
    parent_id: str(c.parent_id),
    topic: str(c.topic),
    nsfw: boolOr(c.nsfw, false),
    last_message_id: str(c.last_message_id),
    rate_limit_per_user: num(c.rate_limit_per_user),
    bitrate: num(c.bitrate),
    user_limit: num(c.user_limit),
    created_at: snowflakeToMillis(c.id),
  };
}

// ------------------------------------------------------------------ threads

export const THREAD_COLUMNS: readonly ColumnSpec[] = [
  { name: "thread_id", type: "VARCHAR", doc: "Thread (channel) snowflake id.", nullable: false },
  { name: "guild_id", type: "VARCHAR", doc: "Guild the thread belongs to." },
  { name: "parent_id", type: "VARCHAR", doc: "Text or forum channel the thread was created in." },
  { name: "name", type: "VARCHAR", doc: "Thread name." },
  { name: "type_name", type: "VARCHAR", doc: "PUBLIC_THREAD, PRIVATE_THREAD or ANNOUNCEMENT_THREAD." },
  { name: "owner_id", type: "VARCHAR", doc: "User id of the thread creator." },
  { name: "message_count", type: "INTEGER", doc: "Approximate number of messages (excluding the starter)." },
  { name: "member_count", type: "INTEGER", doc: "Approximate number of members (stops counting at 50)." },
  { name: "archived", type: "BOOLEAN", doc: "True when archived." },
  { name: "locked", type: "BOOLEAN", doc: "True when only moderators can unarchive." },
  { name: "auto_archive_minutes", type: "INTEGER", doc: "Inactivity minutes before auto-archive." },
  { name: "applied_tags", type: "VARCHAR[]", doc: "Forum tag ids applied to the thread." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Thread creation time." },
  { name: "archived_at", type: "TIMESTAMPTZ", doc: "Last archive-status change." },
];

export function mapThread(t: Json): Row {
  const meta = t.thread_metadata ?? {};
  return {
    thread_id: str(t.id),
    guild_id: str(t.guild_id),
    parent_id: str(t.parent_id),
    name: str(t.name),
    type_name: channelTypeName(num(t.type)),
    owner_id: str(t.owner_id),
    message_count: num(t.message_count),
    member_count: num(t.member_count),
    archived: boolOr(meta.archived),
    locked: boolOr(meta.locked),
    auto_archive_minutes: num(meta.auto_archive_duration),
    applied_tags: strList(t.applied_tags),
    created_at: isoToMillis(meta.create_timestamp) ?? snowflakeToMillis(t.id),
    archived_at: isoToMillis(meta.archive_timestamp),
  };
}

// ------------------------------------------------------------------ roles

export const ROLE_COLUMNS: readonly ColumnSpec[] = [
  {
    name: "role_id",
    type: "VARCHAR",
    doc: "Role snowflake id (the @everyone role's id equals the guild id).",
    nullable: false,
  },
  { name: "guild_id", type: "VARCHAR", doc: "Guild the role belongs to." },
  { name: "name", type: "VARCHAR", doc: "Role name." },
  { name: "color", type: "INTEGER", doc: "RGB color as an integer (0 = no color)." },
  { name: "color_hex", type: "VARCHAR", doc: "Color as #rrggbb, NULL when the role has no color." },
  { name: "hoist", type: "BOOLEAN", doc: "True when shown separately in the member list." },
  { name: "position", type: "INTEGER", doc: "Position in the role hierarchy (higher wins)." },
  { name: "permissions", type: "VARCHAR", doc: "Permission bit set (decimal string); decode with permission_names()." },
  { name: "managed", type: "BOOLEAN", doc: "True when managed by an integration or bot." },
  { name: "mentionable", type: "BOOLEAN", doc: "True when anyone can @mention the role." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Role creation time, from the snowflake." },
];

export function mapRole(r: Json, guildId: string): Row {
  return {
    role_id: str(r.id),
    guild_id: guildId,
    name: str(r.name),
    color: num(r.color),
    color_hex: colorHex(num(r.color)),
    hoist: boolOr(r.hoist, false),
    position: num(r.position),
    permissions: str(r.permissions),
    managed: boolOr(r.managed, false),
    mentionable: boolOr(r.mentionable, false),
    created_at: snowflakeToMillis(r.id),
  };
}

// ------------------------------------------------------------------ members

export const MEMBER_COLUMNS: readonly ColumnSpec[] = [
  { name: "user_id", type: "VARCHAR", doc: "Member's user snowflake id.", nullable: false },
  { name: "guild_id", type: "VARCHAR", doc: "Guild id." },
  { name: "username", type: "VARCHAR", doc: "Unique username." },
  { name: "global_name", type: "VARCHAR", doc: "Account-wide display name." },
  { name: "nick", type: "VARCHAR", doc: "Guild-specific nickname." },
  { name: "display_name", type: "VARCHAR", doc: "What Discord shows: nick, else global_name, else username." },
  { name: "is_bot", type: "BOOLEAN", doc: "True for bot accounts." },
  { name: "role_ids", type: "VARCHAR[]", doc: "Ids of roles assigned to the member (excluding @everyone)." },
  { name: "joined_at", type: "TIMESTAMPTZ", doc: "When the member joined the guild." },
  { name: "premium_since", type: "TIMESTAMPTZ", doc: "When the member started boosting, if boosting." },
  { name: "pending", type: "BOOLEAN", doc: "True until the member passes membership screening." },
  { name: "timed_out_until", type: "TIMESTAMPTZ", doc: "End of an active timeout, if any." },
  { name: "avatar", type: "VARCHAR", doc: "User avatar hash." },
  { name: "account_created_at", type: "TIMESTAMPTZ", doc: "User account creation time, from the snowflake." },
];

export function mapMember(m: Json, guildId: string): Row {
  const u = m.user ?? {};
  return {
    user_id: str(u.id),
    guild_id: guildId,
    username: str(u.username),
    global_name: str(u.global_name),
    nick: str(m.nick),
    display_name: str(m.nick ?? u.global_name ?? u.username),
    is_bot: boolOr(u.bot, false),
    role_ids: strList(m.roles),
    joined_at: isoToMillis(m.joined_at),
    premium_since: isoToMillis(m.premium_since),
    pending: boolOr(m.pending, false),
    timed_out_until: isoToMillis(m.communication_disabled_until),
    avatar: str(u.avatar),
    account_created_at: snowflakeToMillis(u.id),
  };
}

// ------------------------------------------------------------------ emojis

export const EMOJI_COLUMNS: readonly ColumnSpec[] = [
  { name: "emoji_id", type: "VARCHAR", doc: "Emoji snowflake id.", nullable: false },
  { name: "guild_id", type: "VARCHAR", doc: "Guild id." },
  { name: "name", type: "VARCHAR", doc: "Emoji name (use as :name: in messages)." },
  { name: "animated", type: "BOOLEAN", doc: "True for animated emojis." },
  { name: "available", type: "BOOLEAN", doc: "False when unavailable (lost boosts)." },
  { name: "managed", type: "BOOLEAN", doc: "True when managed by an integration." },
  { name: "role_ids", type: "VARCHAR[]", doc: "Roles allowed to use the emoji (empty = everyone)." },
  { name: "creator_id", type: "VARCHAR", doc: "User who uploaded it (needs Manage Expressions)." },
  { name: "markup", type: "VARCHAR", doc: "Message markup, e.g. <:name:id> or <a:name:id>." },
  { name: "url", type: "VARCHAR", doc: "CDN URL of the emoji image." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "Upload time, from the snowflake." },
];

export function mapEmoji(e: Json, guildId: string): Row {
  const animated = boolOr(e.animated, false);
  return {
    emoji_id: str(e.id),
    guild_id: guildId,
    name: str(e.name),
    animated,
    available: boolOr(e.available, true),
    managed: boolOr(e.managed, false),
    role_ids: strList(e.roles),
    creator_id: str(e.user?.id),
    markup: `<${animated ? "a" : ""}:${e.name}:${e.id}>`,
    url: `https://cdn.discordapp.com/emojis/${e.id}.${animated ? "gif" : "png"}`,
    created_at: snowflakeToMillis(e.id),
  };
}

// ------------------------------------------------------------------ scheduled events

const EVENT_STATUS: Record<number, string> = { 1: "SCHEDULED", 2: "ACTIVE", 3: "COMPLETED", 4: "CANCELED" };
const EVENT_ENTITY: Record<number, string> = { 1: "STAGE_INSTANCE", 2: "VOICE", 3: "EXTERNAL" };

export const EVENT_COLUMNS: readonly ColumnSpec[] = [
  { name: "event_id", type: "VARCHAR", doc: "Scheduled event snowflake id.", nullable: false },
  { name: "guild_id", type: "VARCHAR", doc: "Guild id." },
  { name: "name", type: "VARCHAR", doc: "Event name." },
  { name: "description", type: "VARCHAR", doc: "Event description." },
  { name: "status", type: "VARCHAR", doc: "SCHEDULED, ACTIVE, COMPLETED or CANCELED." },
  { name: "entity_type", type: "VARCHAR", doc: "STAGE_INSTANCE, VOICE or EXTERNAL." },
  { name: "channel_id", type: "VARCHAR", doc: "Voice/stage channel id (NULL for external events)." },
  { name: "location", type: "VARCHAR", doc: "Location of an external event." },
  { name: "creator_id", type: "VARCHAR", doc: "User who created the event." },
  { name: "user_count", type: "INTEGER", doc: "Users subscribed to the event." },
  { name: "scheduled_start", type: "TIMESTAMPTZ", doc: "Scheduled start time." },
  { name: "scheduled_end", type: "TIMESTAMPTZ", doc: "Scheduled end time, if set." },
];

export function mapEvent(e: Json): Row {
  return {
    event_id: str(e.id),
    guild_id: str(e.guild_id),
    name: str(e.name),
    description: str(e.description),
    status: EVENT_STATUS[e.status as number] ?? str(e.status),
    entity_type: EVENT_ENTITY[e.entity_type as number] ?? str(e.entity_type),
    channel_id: str(e.channel_id),
    location: str(e.entity_metadata?.location),
    creator_id: str(e.creator_id),
    user_count: num(e.user_count),
    scheduled_start: isoToMillis(e.scheduled_start_time),
    scheduled_end: isoToMillis(e.scheduled_end_time),
  };
}

// ------------------------------------------------------------------ messages

export const MESSAGE_COLUMNS: readonly ColumnSpec[] = [
  { name: "message_id", type: "VARCHAR", doc: "Message snowflake id.", nullable: false },
  { name: "channel_id", type: "VARCHAR", doc: "Channel (or thread) the message is in." },
  { name: "author_id", type: "VARCHAR", doc: "Author's user id (the webhook id for webhook messages)." },
  { name: "author_username", type: "VARCHAR", doc: "Author's username." },
  { name: "author_global_name", type: "VARCHAR", doc: "Author's display name." },
  { name: "author_is_bot", type: "BOOLEAN", doc: "True when the author is a bot." },
  { name: "webhook_id", type: "VARCHAR", doc: "Set when a webhook posted the message." },
  { name: "type", type: "INTEGER", doc: "Message type: 0 default, 19 reply, 7 member join, ..." },
  { name: "content", type: "VARCHAR", doc: "Message text (empty without the Message Content intent)." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "When the message was sent." },
  { name: "edited_at", type: "TIMESTAMPTZ", doc: "When the message was last edited, if ever." },
  { name: "pinned", type: "BOOLEAN", doc: "True when pinned." },
  { name: "tts", type: "BOOLEAN", doc: "True for text-to-speech messages." },
  { name: "mention_everyone", type: "BOOLEAN", doc: "True when the message mentions @everyone or @here." },
  { name: "mentioned_user_ids", type: "VARCHAR[]", doc: "Ids of users mentioned." },
  { name: "mentioned_role_ids", type: "VARCHAR[]", doc: "Ids of roles mentioned." },
  { name: "attachment_count", type: "INTEGER", doc: "Number of attached files." },
  { name: "attachment_urls", type: "VARCHAR[]", doc: "CDN URLs of attached files." },
  { name: "embed_count", type: "INTEGER", doc: "Number of embeds." },
  { name: "reactions", type: "REACTIONS", doc: "Reactions as a list of {emoji, count}." },
  { name: "reaction_count", type: "INTEGER", doc: "Total reactions across all emojis." },
  { name: "referenced_message_id", type: "VARCHAR", doc: "Message this one replies to or forwards." },
  { name: "thread_id", type: "VARCHAR", doc: "Thread started from this message, if any." },
  { name: "flags", type: "INTEGER", doc: "Message flag bit set." },
];

/** Emoji text for a reaction: the unicode character or `name:id` for custom emojis. */
export function emojiText(emoji: Json): string | null {
  if (!emoji) return null;
  return emoji.id ? `${emoji.name}:${emoji.id}` : str(emoji.name);
}

export function mapMessage(m: Json): Row {
  const author = m.author ?? {};
  const reactions = Array.isArray(m.reactions)
    ? m.reactions.map((r: Json) => ({ emoji: emojiText(r.emoji), count: num(r.count) ?? 0 }))
    : [];
  return {
    message_id: str(m.id),
    channel_id: str(m.channel_id),
    author_id: str(author.id),
    author_username: str(author.username),
    author_global_name: str(author.global_name),
    author_is_bot: boolOr(author.bot, false),
    webhook_id: str(m.webhook_id),
    type: num(m.type),
    content: str(m.content),
    created_at: isoToMillis(m.timestamp) ?? snowflakeToMillis(m.id),
    edited_at: isoToMillis(m.edited_timestamp),
    pinned: boolOr(m.pinned, false),
    tts: boolOr(m.tts, false),
    mention_everyone: boolOr(m.mention_everyone, false),
    mentioned_user_ids: Array.isArray(m.mentions) ? m.mentions.map((u: Json) => String(u.id)) : [],
    mentioned_role_ids: strList(m.mention_roles),
    attachment_count: Array.isArray(m.attachments) ? m.attachments.length : 0,
    attachment_urls: Array.isArray(m.attachments) ? m.attachments.map((a: Json) => String(a.url)) : [],
    embed_count: Array.isArray(m.embeds) ? m.embeds.length : 0,
    reactions,
    reaction_count: reactions.reduce((n: number, r: { count: number }) => n + r.count, 0),
    referenced_message_id: str(m.message_reference?.message_id),
    thread_id: str(m.thread?.id),
    flags: num(m.flags),
  };
}
