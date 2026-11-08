/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "discord";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/your-org/vgi-discord";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "account", title: "Account", description: "The bot account behind the configured token." },
  { name: "guilds", title: "Guilds", description: "Servers the bot is in: details, emojis and scheduled events." },
  { name: "channels", title: "Channels", description: "Channels and threads within a guild." },
  { name: "members", title: "Members & Roles", description: "Guild members and the roles assigned to them." },
  { name: "messages", title: "Messages", description: "Message history, pins and reactions." },
  { name: "write", title: "Write Actions", description: "Functions that post, edit, delete or react on Discord." },
  { name: "utilities", title: "Utilities", description: "Pure helpers: snowflakes, markup, URLs and permissions." },
  { name: "reference", title: "Reference Tables", description: "Static Discord reference data." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const AUTH =
  "API-backed functions authenticate with a Discord bot token, read from a DuckDB secret of type discord " +
  "(field token; optional api_base overrides https://discord.com/api/v10) or from the DISCORD_BOT_TOKEN " +
  "environment variable. The pure helpers and reference tables need no token.";

export const CATALOG_DOC_LLM =
  "Query and act on Discord from SQL through a bot account. Reach for this worker to analyze community " +
  "activity (who posts, when, which channels and threads are busy, how members join, which reactions win), " +
  "to audit guild structure (channels, roles and their permission bit sets, emojis, events), and to push " +
  "results back into Discord as messages, webhook posts, edits or reactions. Key concepts: every Discord " +
  "object id is a snowflake, kept as text exactly as the API sends it, and encodes its creation time; a " +
  "time window over message history is read by converting a timestamp into a snowflake cursor; guild-scoped " +
  "readers take a guild id and message readers take a channel or thread id; long histories stream one API " +
  "page per Arrow batch and stop at a row cap; write functions act every time the query runs and never ping " +
  "anyone unless mentions are explicitly allowed. Discord rate limits are honoured automatically. Reading " +
  "members needs the Server Members intent and message text needs the Message Content intent. " +
  AUTH;

export const CATALOG_DOC_MD =
  "# Discord for DuckDB\n\n" +
  "**Read servers, channels, members and message history from Discord, and post messages back, all from SQL.** " +
  "A [VGI](https://query.farm/vgi) worker over the Discord REST API (v10), using a bot token.\n\n" +
  "- **Analyze** activity: message history, reactions, pins, threads, member joins.\n" +
  "- **Audit** structure: channels, roles and permissions, emojis, scheduled events.\n" +
  "- **Act**: send one message or one per row, post via webhooks, edit, delete, react. " +
  "Mentions never ping unless you opt in.\n" +
  "- **Decode** snowflake ids, build time-window cursors, format mentions and timestamps.\n\n" +
  "Store the bot token in a DuckDB secret of type `discord` (or the `DISCORD_BOT_TOKEN` environment variable). " +
  "Rate limits are respected automatically.";

export const SCHEMA_DOC_LLM =
  "The main schema holds every Discord object. Readers come in two scopes: guild-scoped ones take a guild id " +
  "(find ids in the guilds listing) and message readers take a channel or thread id (from the channel or " +
  "thread listings). Paginated readers stream one API page per batch; member and message readers take a named " +
  "row cap, and message history takes before_id / after_id snowflake cursors. Write functions are table " +
  "functions that return the created or affected row; bulk sending is a table in-out function fed by a " +
  "subquery with channel_id and content columns. Scalars cannot take named arguments; table functions can. " +
  AUTH;

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "All Discord functions and reference tables.\n\n" +
  "- **Readers** return rows from the Discord API, streamed page by page.\n" +
  "- **Writers** post, edit, delete or react and return what Discord created.\n" +
  "- **Utilities** are pure scalars and reference tables that need no token.";

export const AGENT_TEST_TASKS = [
  {
    name: "snowflake_created",
    prompt:
      "Using the discord worker, when was the Discord object with id 175928847299117063 created? Return epoch milliseconds.",
  },
  {
    name: "snowflake_breakdown",
    prompt:
      "Using the discord worker, what are the worker id, process id and increment encoded in Discord id 175928847299117063?",
  },
  {
    name: "time_cursor",
    prompt:
      "Using the discord worker, what message id cursor corresponds to 2026-01-01 00:00 UTC, for reading messages after that time?",
  },
  {
    name: "decode_permissions",
    prompt:
      "Using the discord worker, which permission flag names are set in the Discord permission bit set '268435464'?",
  },
  {
    name: "admin_check",
    prompt: "Using the discord worker, does the permission bit set '268435464' include the Administrator permission?",
  },
  {
    name: "permission_bits",
    prompt:
      "Using the discord worker, list the names and bit positions of every Discord permission flag whose name starts with MANAGE_, by bit.",
  },
  {
    name: "thread_types",
    prompt: "Using the discord worker, list the channel type numbers of all Discord thread channel types, ascending.",
  },
  {
    name: "type_name",
    prompt: "Using the discord worker, what is the name of Discord channel type 13?",
  },
  {
    name: "relative_timestamp",
    prompt:
      "Using the discord worker, produce Discord markup that shows 2026-01-01 00:00 UTC as a relative time to each reader.",
  },
  {
    name: "mentions",
    prompt:
      "Using the discord worker, build the mention markup for user, channel and role 80351110224678912 (three values).",
  },
  {
    name: "escape_text",
    prompt: "Using the discord worker, escape the text '**not bold** my_file' so Discord shows it literally.",
  },
  {
    name: "links",
    prompt:
      "Using the discord worker, build the link to message 3 in channel 2 of guild 1, and the avatar URL of user " +
      "80351110224678912 whose avatar hash is 'abc123'.",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Discord for DuckDB",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray(
    "vgi, duckdb, discord, chat, bot, messages, guilds, community analytics, notifications",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Discord Functions",
  domain: "communication",
  "vgi.keywords": keywordsArray("discord, guilds, channels, members, messages, webhooks, snowflakes, permissions"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
