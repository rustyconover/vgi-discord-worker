/**
 * Write functions: post, edit and delete messages, react, and post through
 * webhooks. Each single-action function is a table function that performs its
 * request once and returns the resulting row, so it can be called from SQL
 * (`SELECT * FROM discord.main.send_message(...)`). `send_messages` is a table
 * in-out function that posts one message per row of a query.
 *
 * Mentions are suppressed by default (`allow_mentions := false`) so a query can
 * never ping @everyone by accident.
 */

import { bool, defineTableInOutFunction, utf8, type VgiBatch } from "@query-farm/vgi";
import { DiscordClient, SECRET_TYPE, seg } from "./discord/api.ts";
import { parseSnowflake } from "./discord/convert.ts";
import { MESSAGE_COLUMNS, mapMessage } from "./discord/models.ts";
import {
  type ColumnSpec,
  defineDiscordTable,
  onePage,
  resultColumnsTag,
  rowsToBatch,
  schemaOf,
} from "./discord/table.ts";
import { objectTags } from "./meta.ts";

// biome-ignore lint/suspicious/noExplicitAny: raw Discord JSON
type Json = any;

const SNOWFLAKE = "^[0-9]{1,20}$";
export const MAX_CONTENT = 2000;
const CHANNEL_ID_DOC = "Channel or thread snowflake id to post in.";
const CONTENT_DOC = "Message text; must not be empty or exceed Discord's message length limit. Markdown is rendered.";
const ALLOW_MENTIONS_DOC =
  "When false (default) no @user, @role or @everyone mention in the text pings anyone; true lets them ping.";
const AUTH_NOTE =
  "Authenticates with the bot token stored in a DuckDB secret of type discord (field token, optional api_base), " +
  "or the DISCORD_BOT_TOKEN environment variable.";
const SIDE_EFFECT_NOTE = "This function changes Discord: every execution of the query performs the action again.";

/** Reject empty or over-long content before calling Discord. */
export function checkContent(content: string | null | undefined): string {
  if (content == null || content.trim() === "") throw new Error("content must not be empty");
  if ([...content].length > MAX_CONTENT) throw new Error(`content is longer than ${MAX_CONTENT} characters`);
  return content;
}

/** The JSON body for creating a message. */
export function messageBody(
  content: string,
  opts: { replyTo?: string | null; allowMentions?: boolean; tts?: boolean },
) {
  const body: Record<string, unknown> = {
    content,
    allowed_mentions: opts.allowMentions
      ? { parse: ["users", "roles", "everyone"], replied_user: true }
      : { parse: [] },
  };
  if (opts.tts) body.tts = true;
  if (opts.replyTo) body.message_reference = { message_id: opts.replyTo, fail_if_not_exists: false };
  return body;
}

// ------------------------------------------------------------------ send_message

interface SendArgs {
  channel_id: string;
  content: string;
  reply_to: string | null;
  allow_mentions: boolean;
  tts: boolean;
}

export const sendMessage = defineDiscordTable<SendArgs>({
  name: "send_message",
  description: "Post a message to a Discord channel and return the created message",
  args: { channel_id: utf8(), content: utf8(), reply_to: utf8(), allow_mentions: bool, tts: bool },
  argDefaults: { reply_to: null, allow_mentions: false, tts: false },
  argDocs: {
    channel_id: CHANNEL_ID_DOC,
    content: CONTENT_DOC,
    reply_to: "Message id to reply to in the same channel; NULL (default) for a normal message.",
    allow_mentions: ALLOW_MENTIONS_DOC,
    tts: "Send as a text-to-speech message. Default false.",
  },
  argConstraints: { channel_id: { pattern: SNOWFLAKE } },
  validate: (args) => {
    checkContent(args.content);
    if (args.reply_to != null && parseSnowflake(args.reply_to) == null)
      throw new Error("reply_to must be a snowflake id string");
  },
  columns: MESSAGE_COLUMNS,
  fetchPage: async ({ client, args }) => {
    const body = messageBody(checkContent(args.content), {
      replyTo: args.reply_to,
      allowMentions: args.allow_mentions,
      tts: args.tts,
    });
    const created = await client.request<Json>("POST", `/channels/${seg(args.channel_id)}/messages`, { body });
    return onePage([mapMessage(created)]);
  },
  doc: {
    title: "Send Message",
    category: "write",
    keywords: "discord, send message, post, notify, alert, chat, reply",
    docLlm:
      "Post one message (endpoint POST /channels/{channel_id}/messages) and return the created message as one row with " +
      "the columns of messages(). Named options: reply_to (message id to reply to), allow_mentions (default " +
      "false: mentions in the text do not ping), tts. Content must not be empty or exceed two thousand characters. To post one message " +
      `per row of a query use send_messages. ${SIDE_EFFECT_NOTE} ${AUTH_NOTE}`,
    docMd:
      "## send_message(channel_id, content, reply_to := NULL, allow_mentions := false, tts := false)\n\n" +
      `Post a message and get it back as a row. ${SIDE_EFFECT_NOTE}\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT message_id, created_at FROM discord.main.send_message('123456789012345678', 'Nightly load finished ✅')",
      description: "Announce that a job finished",
    },
  ],
});

// ------------------------------------------------------------------ send_messages (table in-out)

const SEND_RESULT_COLUMNS: readonly ColumnSpec[] = [
  { name: "channel_id", type: "VARCHAR", doc: "Channel the message was posted to (from the input row)." },
  { name: "message_id", type: "VARCHAR", doc: "Id of the created message; NULL if it failed." },
  { name: "created_at", type: "TIMESTAMPTZ", doc: "When the message was created; NULL if it failed." },
  { name: "ok", type: "BOOLEAN", doc: "True when the message was posted.", nullable: false },
  { name: "error", type: "VARCHAR", doc: "Error message (with HTTP status) when ok is false." },
];
const SEND_RESULT_SCHEMA = schemaOf(SEND_RESULT_COLUMNS);

interface SendManyArgs {
  fail_on_error: boolean;
  allow_mentions: boolean;
}

function textColumn(batch: VgiBatch, name: string): (string | null)[] {
  const col = batch.getChild(name);
  return Array.from({ length: batch.numRows }, (_, i) => {
    const v = col?.get(i);
    return v == null ? null : String(v);
  });
}

export const sendMessages = defineTableInOutFunction<SendManyArgs>({
  name: "send_messages",
  description: "Post one Discord message per input row (columns channel_id, content, optional reply_to)",
  namedArgs: { fail_on_error: bool, allow_mentions: bool },
  argDefaults: { fail_on_error: true, allow_mentions: false },
  argDocs: {
    fail_on_error:
      "When true (default) the first failure aborts the query; false records it in ok/error and continues.",
    allow_mentions: ALLOW_MENTIONS_DOC,
  },
  requiredSecrets: [SECRET_TYPE],
  onBind: (params) => {
    const names = new Set((params.bindCall.input_schema?.fields ?? []).map((f) => f.name));
    for (const required of ["channel_id", "content"]) {
      if (!names.has(required)) throw new Error(`send_messages needs an input column named '${required}'`);
    }
    return { outputSchema: SEND_RESULT_SCHEMA };
  },
  // Posts sequentially (Discord rate-limits per channel anyway) and emits one result row per input row.
  process: async (params, _state, batch, out) => {
    const client = DiscordClient.fromSecrets(params.secrets);
    const channelIds = textColumn(batch, "channel_id");
    const contents = textColumn(batch, "content");
    const replies = batch.getChild("reply_to") ? textColumn(batch, "reply_to") : [];
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      const channelId = channelIds[i] ?? null;
      try {
        if (channelId == null || parseSnowflake(channelId) == null)
          throw new Error("channel_id must be a snowflake id string");
        const body = messageBody(checkContent(contents[i]), {
          replyTo: replies[i] ?? null,
          allowMentions: params.args.allow_mentions,
        });
        const created = mapMessage(
          await client.request<Json>("POST", `/channels/${seg(channelId)}/messages`, { body }),
        );
        rows.push({
          channel_id: channelId,
          message_id: created.message_id,
          created_at: created.created_at,
          ok: true,
          error: null,
        });
      } catch (err) {
        if (params.args.fail_on_error ?? true) throw err;
        rows.push({
          channel_id: channelId,
          message_id: null,
          created_at: null,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    out.emit(rowsToBatch(rows, params.outputSchema));
  },
  tags: {
    ...objectTags({
      title: "Send Messages (Bulk)",
      category: "write",
      keywords: "discord, bulk send, broadcast, notifications, send many, table in-out",
      docLlm:
        "Post one message per row of a subquery passed as the table argument `data` (wrap it in double " +
        "parentheses). The input needs text columns `channel_id` and `content`, and may have `reply_to`. " +
        "Returns one row per input row: channel_id, message_id, created_at, ok, error. Named options: " +
        "fail_on_error (default true; false records failures and continues), allow_mentions (default false). " +
        `Messages are sent in order, respecting Discord rate limits. ${SIDE_EFFECT_NOTE} The token is read from ` +
        "the discord secret, otherwise from the DISCORD_BOT_TOKEN environment variable.",
      docMd:
        "## send_messages(data, fail_on_error := true, allow_mentions := false)\n\n" +
        "`data` is a subquery with `channel_id` and `content` columns (and optionally `reply_to`).\n\n" +
        `Post one message per input row and report what happened to each. ${SIDE_EFFECT_NOTE}`,
    }),
    "vgi.result_columns_schema": resultColumnsTag(SEND_RESULT_COLUMNS),
  },
  examples: [
    {
      sql:
        "SELECT count(*) FILTER (WHERE ok) AS sent FROM discord.main.send_messages(" +
        "(SELECT '123456789012345678' AS channel_id, 'Low stock: ' || sku AS content " +
        "FROM (VALUES ('A-1', 2), ('B-7', 40)) inv(sku, qty) WHERE qty < 5), " +
        "fail_on_error := false)",
      description: "Post a low-stock alert per item and count successes",
    },
  ],
});

// ------------------------------------------------------------------ send_webhook

const WEBHOOK_PATH = /\/webhooks\/(\d{1,20})\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/;

/** Extract the webhook id and token from a Discord webhook URL. */
export function parseWebhookUrl(url: string): { id: string; token: string } {
  const m = url.match(WEBHOOK_PATH);
  if (!m) throw new Error("webhook_url must look like https://discord.com/api/webhooks/<id>/<token>");
  return { id: m[1] as string, token: m[2] as string };
}

interface WebhookArgs {
  webhook_url: string;
  content: string;
  username: string | null;
  avatar_url: string | null;
  allow_mentions: boolean;
}

export const sendWebhook = defineDiscordTable<WebhookArgs>({
  name: "send_webhook",
  description: "Post a message through a Discord webhook URL (no bot token needed)",
  args: { webhook_url: utf8(), content: utf8(), username: utf8(), avatar_url: utf8(), allow_mentions: bool },
  argDefaults: { username: null, avatar_url: null, allow_mentions: false },
  argDocs: {
    webhook_url: "Webhook URL from the channel's Integrations settings: https://discord.com/api/webhooks/<id>/<token>.",
    content: CONTENT_DOC,
    username: "Override the webhook's display name for this message. Default NULL keeps it.",
    avatar_url: "Override the webhook's avatar with this image URL. Default NULL keeps it.",
    allow_mentions: ALLOW_MENTIONS_DOC,
  },
  argConstraints: { webhook_url: { pattern: "^https?://" } },
  validate: (args) => {
    parseWebhookUrl(args.webhook_url);
    checkContent(args.content);
  },
  columns: MESSAGE_COLUMNS,
  fetchPage: async ({ client, args }) => {
    const body: Record<string, unknown> = messageBody(checkContent(args.content), {
      allowMentions: args.allow_mentions,
    });
    if (args.username) body.username = args.username;
    if (args.avatar_url) body.avatar_url = args.avatar_url;
    // The request goes to the configured API base, so a test or lint run that points
    // api_base at a local server never reaches discord.com.
    const { id, token } = parseWebhookUrl(args.webhook_url);
    const created = await client.request<Json>("POST", `/webhooks/${seg(id)}/${seg(token)}`, {
      body,
      auth: false,
      query: { wait: true },
    });
    return onePage([mapMessage(created)]);
  },
  doc: {
    title: "Send Webhook Message",
    category: "write",
    keywords: "discord, webhook, post, notify, alert, incoming webhook",
    docLlm:
      "Post a message through a Discord webhook URL (endpoint POST /webhooks/{id}/{token}?wait=true) and return the created " +
      "message as one row with the columns of messages(). Needs no bot token or secret: the URL carries its " +
      "own credential, so treat it like a password. Optional named args: username, avatar_url, allow_mentions " +
      `(default false). ${SIDE_EFFECT_NOTE}`,
    docMd:
      "## send_webhook(webhook_url, content, username := NULL, avatar_url := NULL, allow_mentions := false)\n\n" +
      `Post through an incoming webhook; no bot required. ${SIDE_EFFECT_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT message_id FROM discord.main.send_webhook('https://discord.com/api/webhooks/123456789012345678/token', " +
        "'Daily revenue: ' || format('{:,}', 12345), username := 'Revenue Bot')",
      description: "Post a daily metric through a webhook",
    },
  ],
});

// ------------------------------------------------------------------ edit / delete / react

interface EditArgs {
  channel_id: string;
  message_id: string;
  content: string;
}

export const editMessage = defineDiscordTable<EditArgs>({
  name: "edit_message",
  description: "Replace the text of a message the bot sent and return the edited message",
  args: { channel_id: utf8(), message_id: utf8(), content: utf8() },
  argDocs: {
    channel_id: "Channel or thread id containing the message.",
    message_id: "Id of a message the bot authored.",
    content: CONTENT_DOC,
  },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, message_id: { pattern: SNOWFLAKE } },
  validate: (args) => {
    checkContent(args.content);
  },
  columns: MESSAGE_COLUMNS,
  fetchPage: async ({ client, args }) => {
    const path = `/channels/${seg(args.channel_id)}/messages/${seg(args.message_id)}`;
    const edited = await client.request<Json>("PATCH", path, {
      body: { content: checkContent(args.content), allowed_mentions: { parse: [] } },
    });
    return onePage([mapMessage(edited)]);
  },
  doc: {
    title: "Edit Message",
    category: "write",
    keywords: "discord, edit message, update message, correct, status message",
    docLlm:
      "Replace the content of a message the bot authored (endpoint PATCH /channels/{channel_id}/messages/{message_id}) " +
      "and return the edited message (edited_at is set). Mentions in the new text do not ping. Discord answers " +
      `HTTP 403 (code 50005) for messages by other users. ${SIDE_EFFECT_NOTE} ${AUTH_NOTE}`,
    docMd: `## edit_message(channel_id, message_id, content)\n\nRewrite a bot message, e.g. a live status line.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql:
        "SELECT edited_at FROM discord.main.edit_message('123456789012345678', '234567890123456789', " +
        "'Status: ' || 3 || ' jobs running')",
      description: "Refresh a status message in place",
    },
  ],
});

const ACTION_COLUMNS: readonly ColumnSpec[] = [
  { name: "channel_id", type: "VARCHAR", doc: "Channel id the action applied to.", nullable: false },
  { name: "message_id", type: "VARCHAR", doc: "Message id the action applied to.", nullable: false },
  { name: "ok", type: "BOOLEAN", doc: "True when Discord accepted the action.", nullable: false },
];

interface MessageRefArgs {
  channel_id: string;
  message_id: string;
}

export const deleteMessage = defineDiscordTable<MessageRefArgs>({
  name: "delete_message",
  description: "Delete a Discord message",
  args: { channel_id: utf8(), message_id: utf8() },
  argDocs: { channel_id: "Channel or thread id containing the message.", message_id: "Id of the message to delete." },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, message_id: { pattern: SNOWFLAKE } },
  columns: ACTION_COLUMNS,
  fetchPage: async ({ client, args }) => {
    await client.request("DELETE", `/channels/${seg(args.channel_id)}/messages/${seg(args.message_id)}`);
    return onePage([{ channel_id: args.channel_id, message_id: args.message_id, ok: true }]);
  },
  doc: {
    title: "Delete Message",
    category: "write",
    keywords: "discord, delete message, remove, moderation, cleanup",
    docLlm:
      "Delete one message (endpoint DELETE /channels/{channel_id}/messages/{message_id}) and return (channel_id, " +
      "message_id, ok). The bot can always delete its own messages; others need Manage Messages. Missing " +
      `messages fail with HTTP 404. This cannot be undone. ${AUTH_NOTE}`,
    docMd: `## delete_message(channel_id, message_id)\n\nPermanently delete a message.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT ok FROM discord.main.delete_message('123456789012345678', '234567890123456789')",
      description: "Delete one message",
    },
  ],
});

interface ReactArgs extends MessageRefArgs {
  emoji: string;
}

const REACT_COLUMNS: readonly ColumnSpec[] = [
  ...ACTION_COLUMNS.slice(0, 2),
  { name: "emoji", type: "VARCHAR", doc: "The emoji added.", nullable: false },
  ACTION_COLUMNS[2] as ColumnSpec,
];

export const addReaction = defineDiscordTable<ReactArgs>({
  name: "add_reaction",
  description: "Add the bot's reaction to a Discord message",
  args: { channel_id: utf8(), message_id: utf8(), emoji: utf8() },
  argDocs: {
    channel_id: "Channel or thread id containing the message.",
    message_id: "Id of the message to react to.",
    emoji: "A unicode emoji such as '✅', or 'name:id' for a custom emoji.",
  },
  argConstraints: { channel_id: { pattern: SNOWFLAKE }, message_id: { pattern: SNOWFLAKE } },
  validate: (args) => {
    if (!args.emoji || args.emoji.trim() === "") throw new Error("emoji must not be empty");
  },
  columns: REACT_COLUMNS,
  fetchPage: async ({ client, args }) => {
    const path = `/channels/${seg(args.channel_id)}/messages/${seg(args.message_id)}/reactions/${seg(args.emoji)}/@me`;
    await client.request("PUT", path);
    return onePage([{ channel_id: args.channel_id, message_id: args.message_id, emoji: args.emoji, ok: true }]);
  },
  doc: {
    title: "Add Reaction",
    category: "write",
    keywords: "discord, react, reaction, emoji, acknowledge, mark done",
    docLlm:
      "React to a message as the bot (endpoint PUT .../messages/{message_id}/reactions/{emoji}/@me) and return " +
      "(channel_id, message_id, emoji, ok). `emoji` is a unicode emoji or `name:id` for a custom emoji. Needs " +
      `Read Message History and Add Reactions. ${SIDE_EFFECT_NOTE} ${AUTH_NOTE}`,
    docMd: `## add_reaction(channel_id, message_id, emoji)\n\nReact to a message, e.g. to mark it handled.\n\n${AUTH_NOTE}`,
  },
  examples: [
    {
      sql: "SELECT ok FROM discord.main.add_reaction('123456789012345678', '234567890123456789', '✅')",
      description: "Mark a message as handled",
    },
  ],
});

// SDK 0.48 does not copy argDocs onto the implicit table input, so describe it directly.
for (const spec of sendMessages.argumentSpecs) {
  if (spec.isTableInput)
    spec.doc = "Subquery of messages to send: text columns channel_id and content, optional reply_to.";
}

export const WRITE_FUNCTIONS = [sendMessage, sendMessages, sendWebhook, editMessage, deleteMessage, addReaction];
