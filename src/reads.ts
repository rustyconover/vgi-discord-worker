/**
 * Read-only table functions over the bot's view of Discord: the bot account,
 * its guilds, and each guild's channels, threads, roles, members, emojis and
 * scheduled events.
 */

import { int64, utf8 } from "@query-farm/vgi";
import { seg } from "./discord/api.ts";
import { compareSnowflakes } from "./discord/convert.ts";
import {
  CHANNEL_COLUMNS,
  EMOJI_COLUMNS,
  EVENT_COLUMNS,
  GUILD_COLUMNS,
  GUILD_DETAIL_COLUMNS,
  MEMBER_COLUMNS,
  mapChannel,
  mapEmoji,
  mapEvent,
  mapGuild,
  mapGuildDetail,
  mapMember,
  mapRole,
  mapThread,
  mapUser,
  ROLE_COLUMNS,
  THREAD_COLUMNS,
  USER_COLUMNS,
} from "./discord/models.ts";
import { defineDiscordTable, onePage } from "./discord/table.ts";

// biome-ignore lint/suspicious/noExplicitAny: raw Discord JSON
type Json = any;

const SNOWFLAKE = "^[0-9]{1,20}$";
const GUILD_ID_DOC = "Guild (server) snowflake id, as a string, e.g. from discord.main.guilds().";
const AUTH_NOTE =
  "Authenticates with the bot token stored in a DuckDB secret of type discord (field token, optional api_base), " +
  "or the DISCORD_BOT_TOKEN environment variable.";

interface GuildArgs {
  guild_id: string;
}

const guildArgs = {
  args: { guild_id: utf8() },
  argDocs: { guild_id: GUILD_ID_DOC },
  argConstraints: { guild_id: { pattern: SNOWFLAKE } },
};

/** `me()`: the bot account the token belongs to. */
export const me = defineDiscordTable<Record<string, never>>({
  name: "me",
  description: "The Discord bot user that the configured token authenticates as",
  columns: USER_COLUMNS,
  fetchPage: async ({ client }) => onePage([mapUser(await client.get<Json>("/users/@me"))]),
  doc: {
    title: "Current Bot User",
    category: "account",
    keywords: "discord, bot, whoami, current user, token, account",
    docLlm:
      "Return one row describing the bot account the configured token belongs to (endpoint GET /users/@me): " +
      `user_id, username, global_name, is_bot, avatar and created_at. Use it to check credentials. ${AUTH_NOTE}`,
    docMd: `## me()\n\nThe bot user behind the configured token. Handy for checking that authentication works.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT user_id, username, created_at FROM discord.main.me()",
      description: "Check which bot the token belongs to",
    },
  ],
});

/** `guilds()`: every guild the bot is in. */
export const guilds = defineDiscordTable<Record<string, never>>({
  name: "guilds",
  description: "Every Discord guild (server) the bot is a member of, with approximate member counts",
  columns: GUILD_COLUMNS,
  fetchPage: async ({ client, cursor }) => {
    const page = await client.get<Json[]>("/users/@me/guilds", {
      limit: 200,
      with_counts: true,
      after: cursor || undefined,
    });
    const last = page.at(-1);
    return { rows: page.map(mapGuild), next: page.length === 200 && last ? String(last.id) : null };
  },
  doc: {
    title: "Bot Guilds",
    category: "guilds",
    keywords: "discord, guilds, servers, communities, member count, list servers",
    docLlm:
      "List every guild (server) the bot belongs to (endpoint GET /users/@me/guilds, paginated 200 at a time) " +
      "with guild_id, name, is_owner, the bot's permissions bit set, features, approximate_member_count, " +
      "approximate_presence_count and created_at. Start here to find guild ids for the other functions. " +
      AUTH_NOTE,
    docMd: `## guilds()\n\nAll servers the bot is in, with approximate member and online counts.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT name, approximate_member_count FROM discord.main.guilds() ORDER BY approximate_member_count DESC LIMIT 10",
      description: "The bot's ten largest servers",
    },
  ],
});

/** `guild(guild_id)`: full details of one guild. */
export const guild = defineDiscordTable<GuildArgs>({
  name: "guild",
  description: "Detailed settings and counts for one Discord guild",
  ...guildArgs,
  columns: GUILD_DETAIL_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage([mapGuildDetail(await client.get<Json>(`/guilds/${seg(args.guild_id)}`, { with_counts: true }))]),
  doc: {
    title: "Guild Details",
    category: "guilds",
    keywords: "discord, guild, server settings, boost level, verification, owner",
    docLlm:
      "Return one row of detail for a guild (endpoint GET /guilds/{guild_id}?with_counts=true): owner_id, " +
      "description, verification_level, premium_tier and boost count, locale, system/rules channels, " +
      "features, member/presence counts, role_count and emoji_count. `guild_id` is a snowflake string. " +
      AUTH_NOTE,
    docMd: `## guild(guild_id)\n\nOne row of settings and counts for a server.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT name, owner_id, premium_tier, approximate_member_count FROM discord.main.guild('123456789012345678')",
      description: "Boost tier and size of one server",
    },
  ],
});

/** `channels(guild_id)`: all channels in a guild. */
export const channels = defineDiscordTable<GuildArgs>({
  name: "channels",
  description: "All channels (text, voice, categories, forums, ...) in a Discord guild",
  ...guildArgs,
  columns: CHANNEL_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage((await client.get<Json[]>(`/guilds/${seg(args.guild_id)}/channels`)).map(mapChannel)),
  doc: {
    title: "Guild Channels",
    category: "channels",
    keywords: "discord, channels, text channels, voice channels, categories, forums",
    docLlm:
      "List every channel in a guild (endpoint GET /guilds/{guild_id}/channels; active threads are not included, " +
      "see active_threads). Columns: channel_id, name, type and type_name (GUILD_TEXT, GUILD_VOICE, " +
      "GUILD_CATEGORY, GUILD_FORUM, ...), position, parent_id (category), topic, nsfw, last_message_id, " +
      "slowmode, voice bitrate/user_limit, created_at. Use the channel_id with messages(). " +
      AUTH_NOTE,
    docMd: `## channels(guild_id)\n\nEvery channel in a server, with its type, category and topic.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT type_name, count(*) AS channels FROM discord.main.channels('123456789012345678') GROUP BY type_name ORDER BY channels DESC",
      description: "Count a server's channels by type",
    },
  ],
});

/** `active_threads(guild_id)`: all active (unarchived) threads in a guild. */
export const activeThreads = defineDiscordTable<GuildArgs>({
  name: "active_threads",
  description: "All active (non-archived) threads in a Discord guild",
  ...guildArgs,
  columns: THREAD_COLUMNS,
  fetchPage: async ({ client, args }) => {
    const body = await client.get<Json>(`/guilds/${seg(args.guild_id)}/threads/active`);
    return onePage((body?.threads ?? []).map(mapThread));
  },
  doc: {
    title: "Active Threads",
    category: "channels",
    keywords: "discord, threads, forum posts, active threads, conversations",
    docLlm:
      "List the guild's active threads (endpoint GET /guilds/{guild_id}/threads/active): thread_id, parent_id " +
      "(the channel or forum it lives in), name, owner_id, message_count, member_count, archived, locked, " +
      "applied forum tags and created_at. A thread_id works as a channel_id for messages(). " +
      AUTH_NOTE,
    docMd: `## active_threads(guild_id)\n\nThreads that are currently open in a server.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT name, message_count FROM discord.main.active_threads('123456789012345678') ORDER BY message_count DESC LIMIT 5",
      description: "The five busiest open threads",
    },
  ],
});

/** `roles(guild_id)`: roles in a guild. */
export const roles = defineDiscordTable<GuildArgs>({
  name: "roles",
  description: "All roles defined in a Discord guild, with colors and permission bit sets",
  ...guildArgs,
  columns: ROLE_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage((await client.get<Json[]>(`/guilds/${seg(args.guild_id)}/roles`)).map((r) => mapRole(r, args.guild_id))),
  doc: {
    title: "Guild Roles",
    category: "members",
    keywords: "discord, roles, permissions, role colors, hierarchy, moderators",
    docLlm:
      "List the guild's roles (endpoint GET /guilds/{guild_id}/roles): role_id, name, color and color_hex, hoist, " +
      "position, permissions (decimal bit-set string), managed, mentionable, created_at. Decode permissions " +
      "with discord.main.permission_names(permissions) or test one with has_permission(permissions, 'NAME'). " +
      "Join role_id to members().role_ids with list_contains / UNNEST. " +
      AUTH_NOTE,
    docMd: `## roles(guild_id)\n\nEvery role in a server. Decode \`permissions\` with \`permission_names()\`.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT name, position FROM discord.main.roles('123456789012345678') " +
        "WHERE discord.main.has_permission(permissions, 'ADMINISTRATOR') ORDER BY position DESC",
      description: "Roles that grant Administrator",
    },
  ],
});

interface MemberArgs extends GuildArgs {
  max_members: bigint;
}

/** `members(guild_id, max_members := 1000)`: guild members, paginated. */
export const members = defineDiscordTable<MemberArgs>({
  name: "members",
  description: "Members of a Discord guild, paginated 1000 at a time (needs the Server Members intent)",
  args: { guild_id: utf8(), max_members: int64() },
  argDefaults: { max_members: 1000 },
  argDocs: { guild_id: GUILD_ID_DOC, max_members: "Stop after this many members; 1 to 1,000,000. Default 1000." },
  argConstraints: { guild_id: { pattern: SNOWFLAKE }, max_members: { ge: 1, le: 1_000_000 } },
  validate: (args) => {
    const n = Number(args.max_members);
    if (!(n >= 1 && n <= 1_000_000)) throw new Error("max_members must be between 1 and 1000000");
  },
  limit: (args) => Number(args.max_members),
  columns: MEMBER_COLUMNS,
  fetchPage: async ({ client, args, cursor, remaining }) => {
    const limit = Math.min(1000, remaining);
    const page = await client.get<Json[]>(`/guilds/${seg(args.guild_id)}/members`, { limit, after: cursor || "0" });
    const ids = page.map((m) => String(m.user?.id ?? "0"));
    const maxId = ids.reduce((a, b) => (compareSnowflakes(a, b) >= 0 ? a : b), "0");
    return { rows: page.map((m) => mapMember(m, args.guild_id)), next: page.length === limit ? maxId : null };
  },
  doc: {
    title: "Guild Members",
    category: "members",
    keywords: "discord, members, users, roster, nicknames, join date, roles",
    docLlm:
      "List guild members (endpoint GET /guilds/{guild_id}/members, 1000 per request, ordered by user id) up to " +
      "`max_members` (named, default 1000). Columns: user_id, username, global_name, nick, display_name, " +
      "is_bot, role_ids (`VARCHAR[]`), joined_at, premium_since, pending, timed_out_until, avatar, " +
      "account_created_at. The bot needs the privileged Server Members intent enabled in the Developer " +
      `Portal, otherwise Discord answers HTTP 403. ${AUTH_NOTE}`,
    docMd:
      "## members(guild_id, max_members := 1000)\n\nThe server's members with nicknames, roles and join dates.\n\n" +
      `Requires the **Server Members** privileged intent. ${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT date_trunc('month', joined_at) AS month, count(*) AS joins " +
        "FROM discord.main.members('123456789012345678', max_members := 50000) WHERE NOT is_bot GROUP BY month ORDER BY month",
      description: "Human members joining per month",
    },
  ],
});

/** `emojis(guild_id)`: custom emojis in a guild. */
export const emojis = defineDiscordTable<GuildArgs>({
  name: "emojis",
  description: "Custom emojis uploaded to a Discord guild",
  ...guildArgs,
  columns: EMOJI_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage((await client.get<Json[]>(`/guilds/${seg(args.guild_id)}/emojis`)).map((e) => mapEmoji(e, args.guild_id))),
  doc: {
    title: "Guild Emojis",
    category: "guilds",
    keywords: "discord, emojis, custom emoji, emotes, stickers, expressions",
    docLlm:
      "List a guild's custom emojis (endpoint GET /guilds/{guild_id}/emojis): emoji_id, name, animated, available, " +
      "managed, role_ids, creator_id, markup (paste-able `<:name:id>`), CDN url and created_at. Pair with " +
      `messages().reactions to see which emojis get used. ${AUTH_NOTE}`,
    docMd: `## emojis(guild_id)\n\nA server's custom emojis with their markup and image URLs.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT name, markup FROM discord.main.emojis('123456789012345678') WHERE animated ORDER BY name",
      description: "A server's animated emojis",
    },
  ],
});

/** `scheduled_events(guild_id)`: upcoming and active events. */
export const scheduledEvents = defineDiscordTable<GuildArgs>({
  name: "scheduled_events",
  description: "Scheduled events in a Discord guild, with subscriber counts",
  ...guildArgs,
  columns: EVENT_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage(
      (await client.get<Json[]>(`/guilds/${seg(args.guild_id)}/scheduled-events`, { with_user_count: true })).map(
        mapEvent,
      ),
    ),
  doc: {
    title: "Scheduled Events",
    category: "guilds",
    keywords: "discord, events, scheduled events, calendar, stage, rsvp",
    docLlm:
      "List a guild's scheduled events (endpoint GET /guilds/{guild_id}/scheduled-events?with_user_count=true): " +
      "event_id, name, description, status (SCHEDULED/ACTIVE/COMPLETED/CANCELED), entity_type " +
      "(STAGE_INSTANCE/VOICE/EXTERNAL), channel_id or location, creator_id, user_count (RSVPs), " +
      `scheduled_start and scheduled_end. ${AUTH_NOTE}`,
    docMd: `## scheduled_events(guild_id)\n\nUpcoming and live events in a server, with RSVP counts.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT name, scheduled_start, user_count FROM discord.main.scheduled_events('123456789012345678') " +
        "WHERE status = 'SCHEDULED' ORDER BY scheduled_start",
      description: "Upcoming events in date order",
    },
  ],
});

export const READ_FUNCTIONS = [me, guilds, guild, channels, activeThreads, roles, members, emojis, scheduledEvents];
