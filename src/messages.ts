/**
 * Message history table functions: channel history, single messages, pins and
 * the users behind a reaction.
 */

import { int64, utf8 } from "@query-farm/vgi";
import { seg } from "./discord/api.ts";
import { compareSnowflakes, isoToMillis, parseSnowflake } from "./discord/convert.ts";
import { MESSAGE_COLUMNS, mapMessage, mapUser, USER_COLUMNS } from "./discord/models.ts";
import { type ColumnSpec, defineDiscordTable, onePage } from "./discord/table.ts";

// biome-ignore lint/suspicious/noExplicitAny: raw Discord JSON
type Json = any;

const SNOWFLAKE = "^[0-9]{1,20}$";
const CHANNEL_ID_DOC = "Channel or thread snowflake id, as a string, e.g. from discord.main.channels().";
const MESSAGE_ID_DOC = "Message snowflake id, as a string.";
const AUTH_NOTE =
  "Authenticates with the bot token stored in a DuckDB secret of type discord (field token, optional api_base), " +
  "or the DISCORD_BOT_TOKEN environment variable.";
const CONTENT_NOTE =
  "Message `content` is empty unless the bot has the privileged Message Content intent (or is mentioned).";

/** Throw unless `value` is NULL or a snowflake string. */
function checkOptionalSnowflake(name: string, value: string | null | undefined): void {
  if (value != null && parseSnowflake(value) == null) throw new Error(`${name} must be a snowflake id string`);
}

interface HistoryArgs {
  channel_id: string;
  max_messages: bigint;
  before_id: string | null;
  after_id: string | null;
}

/** `messages(channel_id, max_messages := 100, before_id := NULL, after_id := NULL)`. */
export const messages = defineDiscordTable<HistoryArgs>({
  name: "messages",
  description: "Message history of a Discord channel or thread, paginated 100 at a time",
  args: { channel_id: utf8(), max_messages: int64(), before_id: utf8(), after_id: utf8() },
  argDefaults: { max_messages: 100, before_id: null, after_id: null },
  argDocs: {
    channel_id: CHANNEL_ID_DOC,
    max_messages: "Stop after this many messages; 1 to 1,000,000. Default 100.",
    before_id:
      "Only messages older than this message id (walks backwards). Build one from a time with snowflake_from_timestamp().",
    after_id: "Only messages newer than this message id (walks forwards). Cannot be combined with before_id.",
  },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, max_messages: { ge: 1, le: 1_000_000 } },
  validate: (args) => {
    const n = Number(args.max_messages);
    if (!(n >= 1 && n <= 1_000_000)) throw new Error("max_messages must be between 1 and 1000000");
    checkOptionalSnowflake("before_id", args.before_id);
    checkOptionalSnowflake("after_id", args.after_id);
    if (args.before_id != null && args.after_id != null) throw new Error("pass before_id or after_id, not both");
  },
  limit: (args) => Number(args.max_messages),
  columns: MESSAGE_COLUMNS,
  fetchPage: async ({ client, args, cursor, remaining }) => {
    const limit = Math.min(100, remaining);
    const forward = args.after_id != null;
    const query = forward
      ? { limit, after: cursor || args.after_id }
      : { limit, before: cursor || args.before_id || undefined };
    const page = await client.get<Json[]>(`/channels/${seg(args.channel_id)}/messages`, query);
    if (page.length === 0) return { rows: [], next: null };
    const ids = page.map((m) => String(m.id));
    const edge = ids.reduce((a, b) => {
      const cmp = compareSnowflakes(a, b);
      return (forward ? cmp >= 0 : cmp <= 0) ? a : b;
    });
    return { rows: page.map(mapMessage), next: page.length === limit ? edge : null };
  },
  doc: {
    title: "Channel Messages",
    category: "messages",
    keywords: "discord, messages, chat history, channel history, conversation, export",
    docLlm:
      "Read a channel's or thread's message history (endpoint GET /channels/{channel_id}/messages, 100 per request). " +
      "By default walks backwards from the newest message; `before_id` starts older, `after_id` walks forwards " +
      "from a point. `max_messages` (named, default 100) caps the rows. Rows are not sorted: add " +
      "ORDER BY created_at. Columns: message_id, author_id/username/global_name/is_bot, content, created_at, " +
      "edited_at, pinned, mentions, attachments, embed_count, reactions (list of {emoji, count}), " +
      "reaction_count, referenced_message_id (replies), thread_id, flags. To read a time window, turn the start " +
      "time into an id cursor with discord.main.snowflake_from_timestamp and pass it as after_id (see the examples). " +
      `${CONTENT_NOTE} ${AUTH_NOTE}`,
    docMd:
      "## messages(channel_id, max_messages := 100, before_id := NULL, after_id := NULL)\n\n" +
      "A channel's message history, newest first, streamed 100 messages per batch.\n\n" +
      `${CONTENT_NOTE} ${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT author_username, count(*) AS messages FROM discord.main.messages('123456789012345678', max_messages := 5000) " +
        "GROUP BY author_username ORDER BY messages DESC LIMIT 10",
      description: "Most active posters in the last 5000 messages",
    },
    {
      sql:
        "SELECT created_at, author_username, content FROM discord.main.messages('123456789012345678', max_messages := 10000, " +
        "after_id := discord.main.snowflake_from_timestamp(TIMESTAMPTZ '2026-01-01 00:00:00+00')) ORDER BY created_at",
      description: "Every message since New Year 2026, oldest first",
    },
  ],
});

interface MessageArgs {
  channel_id: string;
  message_id: string;
}

/** `message(channel_id, message_id)`: one message. */
export const message = defineDiscordTable<MessageArgs>({
  name: "message",
  description: "A single Discord message by channel and message id",
  args: { channel_id: utf8(), message_id: utf8() },
  argDocs: { channel_id: CHANNEL_ID_DOC, message_id: MESSAGE_ID_DOC },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, message_id: { pattern: SNOWFLAKE } },
  columns: MESSAGE_COLUMNS,
  fetchPage: async ({ client, args }) =>
    onePage([mapMessage(await client.get<Json>(`/channels/${seg(args.channel_id)}/messages/${seg(args.message_id)}`))]),
  doc: {
    title: "Single Message",
    category: "messages",
    keywords: "discord, message, lookup, fetch message, message details",
    docLlm:
      "Fetch one message (endpoint GET /channels/{channel_id}/messages/{message_id}) with the same columns as " +
      `messages(). Fails with HTTP 404 (code 10008) when the message does not exist. ${CONTENT_NOTE} ${AUTH_NOTE}`,
    docMd: `## message(channel_id, message_id)\n\nOne message, with the same columns as \`messages()\`.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT author_username, content, reaction_count FROM discord.main.message('123456789012345678', '234567890123456789')",
      description: "Look up one message",
    },
  ],
});

const PINNED_COLUMNS: readonly ColumnSpec[] = [
  { name: "pinned_at", type: "TIMESTAMPTZ", doc: "When the message was pinned." },
  ...MESSAGE_COLUMNS,
];

interface ChannelArgs {
  channel_id: string;
}

/** `pinned_messages(channel_id)`: pins, newest pin first. */
export const pinnedMessages = defineDiscordTable<ChannelArgs>({
  name: "pinned_messages",
  description: "Pinned messages in a Discord channel, most recently pinned first",
  args: { channel_id: utf8() },
  argDocs: { channel_id: CHANNEL_ID_DOC },
  argConstraints: { channel_id: { pattern: SNOWFLAKE } },
  columns: PINNED_COLUMNS,
  fetchPage: async ({ client, args, cursor }) => {
    const body = await client.get<Json>(`/channels/${seg(args.channel_id)}/messages/pins`, {
      limit: 50,
      before: cursor || undefined,
    });
    const items: Json[] = body?.items ?? [];
    const rows = items.map((item) => ({ ...mapMessage(item.message), pinned_at: isoToMillis(item.pinned_at) }));
    const last = items.at(-1);
    return { rows, next: body?.has_more && last ? String(last.pinned_at) : null };
  },
  doc: {
    title: "Pinned Messages",
    category: "messages",
    keywords: "discord, pins, pinned messages, announcements, important messages",
    docLlm:
      "List a channel's pinned messages (endpoint GET /channels/{channel_id}/messages/pins, 50 per request), most " +
      "recently pinned first, with `pinned_at` plus every column of messages(). " +
      `${CONTENT_NOTE} ${AUTH_NOTE}`,
    docMd: `## pinned_messages(channel_id)\n\nA channel's pins with the time each was pinned.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT pinned_at, author_username, content FROM discord.main.pinned_messages('123456789012345678') ORDER BY pinned_at DESC",
      description: "A channel's pins, newest first",
    },
  ],
});

const REACTION_USER_COLUMNS: readonly ColumnSpec[] = [
  { name: "message_id", type: "VARCHAR", doc: "The reacted-to message id.", nullable: false },
  { name: "emoji", type: "VARCHAR", doc: "The emoji, as passed in.", nullable: false },
  ...USER_COLUMNS,
];

interface ReactionArgs {
  channel_id: string;
  message_id: string;
  emoji: string;
}

/** `reaction_users(channel_id, message_id, emoji)`: who reacted with an emoji. */
export const reactionUsers = defineDiscordTable<ReactionArgs>({
  name: "reaction_users",
  description: "Users who reacted to a Discord message with a given emoji",
  args: { channel_id: utf8(), message_id: utf8(), emoji: utf8() },
  argDocs: {
    channel_id: CHANNEL_ID_DOC,
    message_id: MESSAGE_ID_DOC,
    emoji: "A unicode emoji such as '👍', or 'name:id' for a custom emoji (as in messages().reactions).",
  },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, message_id: { pattern: SNOWFLAKE } },
  columns: REACTION_USER_COLUMNS,
  fetchPage: async ({ client, args, cursor }) => {
    const path = `/channels/${seg(args.channel_id)}/messages/${seg(args.message_id)}/reactions/${seg(args.emoji)}`;
    const page = await client.get<Json[]>(path, { limit: 100, after: cursor || undefined });
    const rows = page.map((u) => ({ message_id: args.message_id, emoji: args.emoji, ...mapUser(u) }));
    const maxId = page.map((u) => String(u.id)).reduce((a, b) => (compareSnowflakes(a, b) >= 0 ? a : b), "0");
    return { rows, next: page.length === 100 ? maxId : null };
  },
  doc: {
    title: "Reaction Users",
    category: "messages",
    keywords: "discord, reactions, votes, polls, who reacted, emoji reactions",
    docLlm:
      "List the users who reacted to a message with one emoji (endpoint GET .../messages/{message_id}/reactions/{emoji}, " +
      "100 per request). `emoji` is a unicode emoji or `name:id` for custom emojis, matching the emoji field of " +
      "messages().reactions. Returns message_id, emoji and the user columns of me(). Useful for tallying " +
      `reaction votes. ${AUTH_NOTE}`,
    docMd: `## reaction_users(channel_id, message_id, emoji)\n\nEveryone who reacted with an emoji.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT count(*) FILTER (WHERE NOT is_bot) AS votes " +
        "FROM discord.main.reaction_users('123456789012345678', '234567890123456789', '👍')",
      description: "Count human thumbs-up votes on a message",
    },
  ],
});

export const MESSAGE_FUNCTIONS = [messages, message, pinnedMessages, reactionUsers];
