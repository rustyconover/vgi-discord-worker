/**
 * Pure helpers that need no token or network: snowflake math, mention and
 * timestamp markup, markdown escaping, URLs, permission decoding, and two
 * reference tables (permission flags and channel types).
 *
 * All scalars are vectorized: `compute` receives a whole Arrow batch and
 * returns one value per row. NULL in gives NULL out.
 */

import {
  bool,
  constraintRecord,
  defineScalarFunction,
  type FunctionExample,
  field,
  int32,
  list,
  NullHandling,
  struct,
  type TableDescriptor,
  timestampMicros,
  timestampMillis,
  utf8,
  type VgiBatch,
  type VgiFunction,
} from "@query-farm/vgi";
import {
  avatarUrl,
  CHANNEL_TYPES,
  channelTypeName,
  escapeMarkdown,
  hasPermission,
  mention,
  messageUrl,
  millisToSnowflake,
  PERMISSION_FLAGS,
  permissionNames,
  snowflakeParts,
  snowflakeToMillis,
  TIMESTAMP_STYLES,
  type TimestampStyle,
  timestampMarkdown,
} from "./discord/convert.ts";
import { type ColumnSpec, defineDiscordTable, onePage, resultColumnsTag, schemaOf } from "./discord/table.ts";
import { type Category, objectTags } from "./meta.ts";

/** Column `i` of a batch as an array of length numRows. */
function col<T>(batch: VgiBatch, i: number): (T | null)[] {
  const c = batch.getChildAt(i);
  return Array.from({ length: batch.numRows }, (_, row) => (c?.get(row) ?? null) as T | null);
}

/**
 * A TIMESTAMPTZ argument as Unix milliseconds. The SDK hands timestamps over as
 * (fractional) epoch milliseconds; a raw bigint is microseconds.
 */
export function timestampArgToMillis(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return Math.floor(v);
  return null;
}

/** Scalar TIMESTAMP outputs are bigint in the SDK's rich representation. */
const toBig = (ms: number | null): bigint | null => (ms == null ? null : BigInt(ms));

interface ExecExample {
  description: string;
  sql: string;
  expected_result: unknown[][];
}

interface DocOpts {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  examples: ExecExample[];
}

/** Tags + examples for a deterministic function: every example is also executable. */
function docs(opts: DocOpts): { tags: Record<string, string>; examples: FunctionExample[] } {
  return {
    tags: { ...objectTags(opts), "vgi.executable_examples": JSON.stringify(opts.examples) },
    examples: opts.examples.map((e) => ({ sql: e.sql, description: e.description })),
  };
}

const ID_DOC = "A Discord snowflake id as a string, e.g. '175928847299117063'. Invalid ids give NULL.";

// ------------------------------------------------------------------ snowflakes

export const snowflakeTimestamp = defineScalarFunction({
  name: "snowflake_timestamp",
  description: "Creation time encoded in a Discord snowflake id",
  params: { id: utf8() },
  argDocs: { id: ID_DOC },
  returns: timestampMillis("UTC"),
  compute: (batch) => col<string>(batch, 0).map((id) => toBig(snowflakeToMillis(id))),
  ...docs({
    title: "Snowflake Timestamp",
    category: "utilities",
    keywords: "discord, snowflake, id, timestamp, creation time, decode",
    docLlm:
      "Decode the creation time from any Discord id (user, message, channel, guild, role...): " +
      "((id >> 22) + 1420070400000) milliseconds since the Unix epoch, returned as `TIMESTAMP WITH TIME ZONE`. " +
      "Pass the id as text, as the API returns it (cast integer ids with `::VARCHAR`). Invalid ids give NULL.",
    docMd: "## snowflake_timestamp(id)\n\nWhen a Discord object was created, decoded from its id.",
    examples: [
      {
        description: "Decode the creation time of a user id (UTC epoch milliseconds)",
        sql: "SELECT epoch_ms(discord.main.snowflake_timestamp('175928847299117063')) AS ms",
        expected_result: [[1462015105796]],
      },
    ],
  }),
});

export const snowflakeFromTimestamp = defineScalarFunction({
  name: "snowflake_from_timestamp",
  description: "The smallest Discord snowflake id created at a given time, for before_id/after_id cursors",
  params: { ts: timestampMicros("UTC") },
  argDocs: { ts: "The moment to convert; moments before the Discord epoch (2015) give '0'." },
  returns: utf8(),
  compute: (batch) =>
    col<unknown>(batch, 0).map((v) => {
      const ms = timestampArgToMillis(v);
      return ms == null ? null : millisToSnowflake(ms);
    }),
  ...docs({
    title: "Snowflake From Timestamp",
    category: "utilities",
    keywords: "discord, snowflake, timestamp, cursor, time range, after, before",
    docLlm:
      "Build the smallest snowflake id for a moment in time ((ms - 1420070400000) << 22) as `VARCHAR`. Pass it " +
      "as the after_id or before_id named argument of discord.main.messages() to read a time window.",
    docMd: "## snowflake_from_timestamp(ts)\n\nTurn a time into an id cursor for `messages(..., after_id := ...)`.",
    examples: [
      {
        description: "Id cursor for a fixed instant",
        sql: "SELECT discord.main.snowflake_from_timestamp(TIMESTAMPTZ '2016-04-30 11:18:25.796+00') AS id",
        expected_result: [["175928847298985984"]],
      },
    ],
  }),
});

export const SNOWFLAKE_PARTS_TYPE = struct([
  field("created_at", timestampMillis("UTC"), true),
  field("worker_id", int32, true),
  field("process_id", int32, true),
  field("increment", int32, true),
]);

export const snowflakePartsFn = defineScalarFunction({
  name: "snowflake_parts",
  description: "Split a Discord snowflake id into timestamp, worker id, process id and increment",
  params: { id: utf8() },
  argDocs: { id: ID_DOC },
  returns: SNOWFLAKE_PARTS_TYPE,
  compute: (batch) =>
    col<string>(batch, 0).map((id) => {
      const p = snowflakeParts(id);
      return p == null ? null : { ...p, created_at: BigInt(p.created_at) };
    }),
  ...docs({
    title: "Snowflake Parts",
    category: "utilities",
    keywords: "discord, snowflake, decode, worker id, process id, increment",
    docLlm:
      "Decode every field of a snowflake id into a `STRUCT(created_at TIMESTAMPTZ, worker_id INTEGER, " +
      "process_id INTEGER, increment INTEGER)`. Pick a field with .created_at, .worker_id and so on. Invalid ids give NULL.",
    docMd: "## snowflake_parts(id)\n\nAll four fields packed into a Discord id, as a struct.",
    examples: [
      {
        description: "Worker, process and increment of a known id",
        sql:
          "SELECT p.worker_id, p.process_id, p.increment " +
          "FROM (SELECT discord.main.snowflake_parts('175928847299117063') AS p)",
        expected_result: [[1, 0, 7]],
      },
    ],
  }),
});

// ------------------------------------------------------------------ markup

function mentionFn(kind: "user" | "channel" | "role", example: string): VgiFunction {
  const label = kind === "user" ? "User" : kind === "channel" ? "Channel" : "Role";
  return defineScalarFunction({
    name: `${kind}_mention`,
    description: `Discord mention markup for a ${kind} id, e.g. ${example}`,
    params: { id: utf8() },
    argDocs: { id: `${label} snowflake id as a string. Invalid ids give NULL.` },
    returns: utf8(),
    compute: (batch) => col<string>(batch, 0).map((id) => mention(kind, id)),
    ...docs({
      title: `${label} Mention`,
      category: "utilities",
      keywords: `discord, mention, ${kind} mention, ping, markup`,
      docLlm:
        `Format a ${kind} id as Discord mention markup (${example}) for use in message content. Note that ` +
        "send_message suppresses pings unless allow_mentions := true.",
      docMd: `## ${kind}_mention(id)\n\nMention markup for a ${kind}: \`${example}\`.`,
      examples: [
        {
          description: `Mention a ${kind}`,
          sql: `SELECT discord.main.${kind}_mention('80351110224678912') AS m`,
          expected_result: [[example.replace("id", "80351110224678912")]],
        },
      ],
    }),
  });
}

export const userMention = mentionFn("user", "<@id>");
export const channelMention = mentionFn("channel", "<#id>");
export const roleMention = mentionFn("role", "<@&id>");

const TS_DOC = "The moment to render.";

export const timestampMarkdownFn = defineScalarFunction({
  name: "timestamp_markdown",
  description: "Discord <t:unix> markup that renders a time in each reader's own time zone",
  params: { ts: timestampMicros("UTC") },
  argDocs: { ts: TS_DOC },
  returns: utf8(),
  compute: (batch) => col<unknown>(batch, 0).map((v) => timestampMarkdown(timestampArgToMillis(v))),
  ...docs({
    title: "Timestamp Markdown",
    category: "utilities",
    keywords: "discord, timestamp, time zone, markdown, date formatting",
    docLlm:
      "Format a timestamp as Discord's `<t:unix_seconds>` markup, which every reader sees in their own time " +
      "zone (default long date and short time). Use the two-argument form for other styles.",
    docMd: "## timestamp_markdown(ts)\n\nA `<t:...>` tag that Discord renders in the reader's local time.",
    examples: [
      {
        description: "Render a time for every reader's time zone",
        sql: "SELECT discord.main.timestamp_markdown(TIMESTAMPTZ '2026-01-01 00:00:00+00') AS t",
        expected_result: [["<t:1767225600>"]],
      },
    ],
  }),
});

export const timestampMarkdownStyled = defineScalarFunction({
  name: "timestamp_markdown",
  description: "Discord <t:unix:style> markup in a chosen style (t T d D f F R)",
  parameters: [
    { name: "ts", type: timestampMicros("UTC"), doc: TS_DOC },
    {
      name: "style",
      type: utf8(),
      const: true,
      choices: TIMESTAMP_STYLES,
      doc: "t short time, T long time, d short date, D long date, f short date/time, F long date/time, R relative ('in 2 hours').",
    },
  ],
  returns: utf8(),
  compute: (batch, consts) =>
    col<unknown>(batch, 0).map((v) => timestampMarkdown(timestampArgToMillis(v), consts.style as TimestampStyle)),
  ...docs({
    title: "Timestamp Markdown (Styled)",
    category: "utilities",
    keywords: "discord, timestamp, relative time, countdown, markdown",
    docLlm:
      "Format a timestamp as `<t:unix_seconds:style>`. `style` is a constant: t, T, d, D, f, F or R " +
      "(R renders relative time such as 'in 3 days', handy for countdowns).",
    docMd: "## timestamp_markdown(ts, style)\n\n`<t:...:style>` markup; `R` gives a live relative time.",
    examples: [
      {
        description: "Relative-time markup",
        sql: "SELECT discord.main.timestamp_markdown(TIMESTAMPTZ '2026-01-01 00:00:00+00', 'R') AS t",
        expected_result: [["<t:1767225600:R>"]],
      },
    ],
  }),
});

export const escapeMarkdownFn = defineScalarFunction({
  name: "escape_markdown",
  description: "Escape Discord markdown characters so text displays literally",
  params: { text: utf8() },
  argDocs: { text: "Text to escape; NULL in, NULL out." },
  returns: utf8(),
  compute: (batch) => col<string>(batch, 0).map((t) => escapeMarkdown(t)),
  ...docs({
    title: "Escape Markdown",
    category: "utilities",
    keywords: "discord, markdown, escape, sanitize, literal text",
    docLlm:
      "Backslash-escape Discord markdown (\\ * _ ~ ` | > [ ] ( ) and leading # or -) so user data such as file " +
      "names or SQL output shows literally inside a message.",
    docMd: "## escape_markdown(text)\n\nMake arbitrary text safe to embed in a message.",
    examples: [
      {
        description: "Escape bold and underscore markers",
        sql: "SELECT discord.main.escape_markdown('**not bold** my_file') AS t",
        expected_result: [["\\*\\*not bold\\*\\* my\\_file"]],
      },
    ],
  }),
});

export const messageUrlFn = defineScalarFunction({
  name: "message_url",
  // NULL guild_id / avatar_hash are meaningful, so NULLs reach compute.
  nullHandling: NullHandling.SPECIAL,
  description: "Clickable https://discord.com/channels/... link to a message",
  params: { guild_id: utf8(), channel_id: utf8(), message_id: utf8() },
  argDocs: {
    guild_id: "Guild id; NULL for a direct message (uses @me).",
    channel_id: "Channel id; NULL gives NULL.",
    message_id: "Message id; NULL gives NULL.",
  },
  returns: utf8(),
  compute: (batch) => {
    const g = col<string>(batch, 0);
    const c = col<string>(batch, 1);
    const m = col<string>(batch, 2);
    return g.map((gid, i) => messageUrl(gid, c[i] ?? null, m[i] ?? null));
  },
  ...docs({
    title: "Message URL",
    category: "utilities",
    keywords: "discord, message link, jump url, permalink, url",
    docLlm:
      "Build a message's jump link `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}`. " +
      "A NULL guild_id produces a DM link (`@me`). Combine with messages() to produce clickable reports.",
    docMd: "## message_url(guild_id, channel_id, message_id)\n\nA permalink to a message.",
    examples: [
      {
        description: "Link to a message",
        sql: "SELECT discord.main.message_url('1', '2', '3') AS url",
        expected_result: [["https://discord.com/channels/1/2/3"]],
      },
    ],
  }),
});

export const avatarUrlFn = defineScalarFunction({
  name: "avatar_url",
  // NULL guild_id / avatar_hash are meaningful, so NULLs reach compute.
  nullHandling: NullHandling.SPECIAL,
  description: "CDN URL of a user's avatar (or their default avatar when the hash is NULL)",
  params: { user_id: utf8(), avatar_hash: utf8() },
  argDocs: {
    user_id: "User snowflake id. Invalid ids give NULL.",
    avatar_hash: "Avatar hash from me()/members().avatar; NULL gives the default avatar.",
  },
  returns: utf8(),
  compute: (batch) => {
    const ids = col<string>(batch, 0);
    const hashes = col<string>(batch, 1);
    return ids.map((id, i) => avatarUrl(id, hashes[i] ?? null));
  },
  ...docs({
    title: "Avatar URL",
    category: "utilities",
    keywords: "discord, avatar, profile picture, cdn, image url",
    docLlm:
      "Build the CDN URL of a user's avatar from user_id and avatar hash (animated `a_` hashes give .gif). When " +
      "the hash is NULL returns Discord's default avatar for that user.",
    docMd: "## avatar_url(user_id, avatar_hash)\n\nAn image URL for a user's avatar.",
    examples: [
      {
        description: "Avatar URL from a hash",
        sql: "SELECT discord.main.avatar_url('80351110224678912', 'abc123') AS url",
        expected_result: [["https://cdn.discordapp.com/avatars/80351110224678912/abc123.png"]],
      },
    ],
  }),
});

// ------------------------------------------------------------------ permissions & types

const PERMS_DOC = "A permission bit set as a decimal string, as in roles().permissions or guilds().permissions.";

export const permissionNamesFn = defineScalarFunction({
  name: "permission_names",
  description: "Decode a Discord permission bit set into a list of flag names",
  params: { permissions: utf8() },
  argDocs: { permissions: PERMS_DOC },
  returns: list(utf8()),
  compute: (batch) => col<string>(batch, 0).map((p) => permissionNames(p)),
  ...docs({
    title: "Permission Names",
    category: "utilities",
    keywords: "discord, permissions, bit set, decode, flags, roles",
    docLlm:
      "Decode a permission bit-set string into a `VARCHAR[]` of flag names in bit order, e.g. '2048' -> " +
      "['SEND_MESSAGES']. See the permission_flags table for every flag. Invalid input gives NULL.",
    docMd: "## permission_names(permissions)\n\nThe names of the flags in a permission bit set.",
    examples: [
      {
        description: "Decode View Channel + Send Messages",
        sql: "SELECT discord.main.permission_names('3072') AS names",
        expected_result: [[["VIEW_CHANNEL", "SEND_MESSAGES"]]],
      },
    ],
  }),
});

export const hasPermissionFn = defineScalarFunction({
  name: "has_permission",
  description: "Whether a Discord permission bit set includes a named permission flag",
  params: { permissions: utf8(), permission: utf8() },
  argDocs: {
    permissions: PERMS_DOC,
    permission: "Flag name such as 'ADMINISTRATOR' or 'manage_messages' (case-insensitive).",
  },
  returns: bool,
  compute: (batch) => {
    const perms = col<string>(batch, 0);
    const names = col<string>(batch, 1);
    return perms.map((p, i) => {
      const name = names[i];
      return name == null ? null : hasPermission(p, name);
    });
  },
  ...docs({
    title: "Has Permission",
    category: "utilities",
    keywords: "discord, permissions, check permission, administrator, moderation",
    docLlm:
      "Test one flag in a permission bit set: has_permission(permissions, 'MANAGE_MESSAGES'). The check is " +
      "literal: ADMINISTRATOR implies everything in Discord, so test it too when you need effective " +
      "permissions. Unknown flag names raise an error; invalid bit sets give NULL.",
    docMd: "## has_permission(permissions, permission)\n\nTrue if the bit set includes the flag.",
    examples: [
      {
        description: "Does 8 include ADMINISTRATOR?",
        sql: "SELECT discord.main.has_permission('8', 'ADMINISTRATOR') AS admin",
        expected_result: [[true]],
      },
    ],
  }),
});

export const channelTypeNameFn = defineScalarFunction({
  name: "channel_type_name",
  description: "Name of a Discord channel type number, e.g. 0 -> GUILD_TEXT",
  params: { type: int32 },
  argDocs: { type: "Channel type number as in channels().type. Unknown numbers give NULL." },
  returns: utf8(),
  compute: (batch) => col<number>(batch, 0).map((t) => channelTypeName(t)),
  ...docs({
    title: "Channel Type Name",
    category: "utilities",
    keywords: "discord, channel type, decode, text, voice, forum",
    docLlm: "Translate a channel type number into its name (0 GUILD_TEXT, 2 GUILD_VOICE, 15 GUILD_FORUM, ...).",
    docMd: "## channel_type_name(type)\n\nThe name of a channel type number.",
    examples: [
      {
        description: "Name type 15",
        sql: "SELECT discord.main.channel_type_name(15) AS name",
        expected_result: [["GUILD_FORUM"]],
      },
    ],
  }),
});

// ------------------------------------------------------------------ reference tables

interface ReferenceSpec {
  table: string;
  title: string;
  key: string;
  columns: readonly ColumnSpec[];
  rows: () => Record<string, unknown>[];
  keywords: string;
  docLlm: string;
  docMd: string;
  example: ExecExample;
  rowCount: number;
}

/**
 * A static dataset exposed as a catalog table (`discord.main.<table>`, no parentheses).
 * DuckDB scans it through a backing table function named `<table>_rows`.
 */
function referenceTable(spec: ReferenceSpec): { fn: VgiFunction; table: TableDescriptor } {
  const fn = defineDiscordTable<Record<string, never>>({
    name: `${spec.table}_rows`,
    description: `Backing rows of the ${spec.table} table; query the table instead`,
    columns: spec.columns,
    fetchPage: async () => onePage(spec.rows()),
    doc: {
      title: `${spec.title} (Backing Function)`,
      category: "reference",
      keywords: spec.keywords,
      docLlm: `Returns the same rows as the discord.main.${spec.table} table, which is the preferred entry point. ${spec.docLlm}`,
      docMd: `## ${spec.table}_rows()\n\nThe backing function of the \`${spec.table}\` table; query the table instead.`,
    },
    examples: [
      {
        sql: `SELECT count(*) AS n FROM discord.main.${spec.table}_rows()`,
        description: `Count the ${spec.table} rows`,
      },
    ],
    extraTags: {
      "vgi.executable_examples": JSON.stringify([
        {
          description: `Count the ${spec.table} rows`,
          sql: `SELECT count(*) AS n FROM discord.main.${spec.table}_rows()`,
          expected_result: [[spec.rowCount]],
        },
      ]),
    },
  });
  const constraint = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY") =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.table,
      id,
      kind,
      columns: [[spec.key]],
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  const table: TableDescriptor = {
    name: spec.table,
    comment: `${spec.title}: static Discord reference data, no token needed.`,
    function: fn,
    columns: schemaOf(spec.columns),
    constraints: [constraint(`${spec.key}_not_null`, "NOT_NULL"), constraint("pk", "PRIMARY_KEY")],
    tags: {
      ...objectTags({
        title: spec.title,
        category: "reference",
        keywords: spec.keywords,
        docLlm: spec.docLlm,
        docMd: spec.docMd,
      }),
      domain: "communication",
      "vgi.result_columns_schema": resultColumnsTag(spec.columns),
      "vgi.example_queries": JSON.stringify([{ sql: spec.example.sql, description: spec.example.description }]),
      "vgi.executable_examples": JSON.stringify([spec.example]),
    },
  };
  return { fn, table };
}

const permissionFlags = referenceTable({
  table: "permission_flags",
  title: "Permission Flag Reference",
  key: "name",
  columns: [
    { name: "name", type: "VARCHAR", doc: "Flag name, e.g. SEND_MESSAGES.", nullable: false },
    {
      name: "bit",
      type: "INTEGER",
      doc: "Zero-based bit index in the permission integer (value = 2^bit).",
      nullable: false,
    },
    { name: "value", type: "VARCHAR", doc: "1 << bit as a decimal string.", nullable: false },
    { name: "description", type: "VARCHAR", doc: "What the permission allows." },
  ],
  rows: () => PERMISSION_FLAGS.map((f) => ({ ...f, value: (1n << BigInt(f.bit)).toString() })),
  rowCount: PERMISSION_FLAGS.length,
  keywords: "discord, permissions, flags, reference, bit values",
  docLlm:
    "Every Discord permission flag: name, bit, value (1 << bit, as text) and description. No network or token " +
    "needed. Use it to look up flag names for has_permission or to decode bit sets in SQL.",
  docMd:
    "## permission_flags\n\nOne row per Discord permission flag, keyed by name. Join it to a role's decoded " +
    "permission names, or use `value` to build bit sets by hand.",
  example: {
    description: "The first four flags",
    sql: "SELECT name, bit FROM discord.main.permission_flags WHERE bit < 4 ORDER BY bit",
    expected_result: [
      ["CREATE_INSTANT_INVITE", 0],
      ["KICK_MEMBERS", 1],
      ["BAN_MEMBERS", 2],
      ["ADMINISTRATOR", 3],
    ],
  },
});

const channelTypes = referenceTable({
  table: "channel_types",
  title: "Channel Type Reference",
  key: "type",
  columns: [
    {
      name: "type",
      type: "INTEGER",
      doc: "Channel type enum value as sent by the Discord API (unitless code).",
      nullable: false,
    },
    { name: "name", type: "VARCHAR", doc: "Channel type name.", nullable: false },
    { name: "description", type: "VARCHAR", doc: "What the channel type is." },
  ],
  rows: () => CHANNEL_TYPES.map((c) => ({ ...c })),
  rowCount: CHANNEL_TYPES.length,
  keywords: "discord, channel types, reference, text, voice, thread",
  docLlm:
    "Every Discord channel type: type number, name and description. No network or token needed. Join on the " +
    "type column of discord.main.channels(guild_id) for descriptions.",
  docMd:
    "## channel_types\n\nOne row per Discord channel type, keyed by its number. Join it to the `type` column " +
    "of `channels(guild_id)` to describe each channel.",
  example: {
    description: "Thread channel types",
    sql: "SELECT type, name FROM discord.main.channel_types WHERE name LIKE '%THREAD' ORDER BY type",
    expected_result: [
      [10, "ANNOUNCEMENT_THREAD"],
      [11, "PUBLIC_THREAD"],
      [12, "PRIVATE_THREAD"],
    ],
  },
});

/** Backing table functions of the reference tables (must be registered for scans to resolve). */
export const REFERENCE_FUNCTIONS = [permissionFlags.fn, channelTypes.fn];
/** Reference datasets exposed as catalog tables. */
export const REFERENCE_TABLES: TableDescriptor[] = [permissionFlags.table, channelTypes.table];

export const UTILITY_FUNCTIONS = [
  snowflakeTimestamp,
  snowflakeFromTimestamp,
  snowflakePartsFn,
  userMention,
  channelMention,
  roleMention,
  timestampMarkdownFn,
  timestampMarkdownStyled,
  escapeMarkdownFn,
  messageUrlFn,
  avatarUrlFn,
  permissionNamesFn,
  hasPermissionFn,
  channelTypeNameFn,
];
