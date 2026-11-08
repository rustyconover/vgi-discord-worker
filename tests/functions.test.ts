// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { DiscordClient, resolveAuth, routeKey } from "../src/discord/api.ts";
import {
  avatarUrl,
  channelTypeName,
  escapeMarkdown,
  hasPermission,
  mention,
  messageUrl,
  millisToSnowflake,
  PERMISSION_FLAGS,
  parseSnowflake,
  permissionNames,
  snowflakeParts,
  snowflakeToMillis,
  timestampMarkdown,
} from "../src/discord/convert.ts";
import { mapMember, mapMessage, mapThread } from "../src/discord/models.ts";
import { timestampArgToMillis } from "../src/utilities.ts";
import { checkContent, messageBody } from "../src/writes.ts";

const ROOT = join(import.meta.dir, "..");

// ------------------------------------------------------------ pure helpers

test("snowflakes: decode, encode and split (Discord's documented example)", () => {
  expect(snowflakeToMillis("175928847299117063")).toBe(1462015105796);
  expect(snowflakeToMillis(175928847299117063n)).toBe(1462015105796);
  expect(millisToSnowflake(1462015105796)).toBe("175928847298985984");
  expect(millisToSnowflake(0)).toBe("0");
  expect(snowflakeParts("175928847299117063")).toEqual({
    created_at: 1462015105796,
    worker_id: 1,
    process_id: 0,
    increment: 7,
  });
});

test("snowflakes: invalid input is null", () => {
  for (const bad of ["", "abc", "-1", "1.5", "99999999999999999999999", null, undefined]) {
    expect(parseSnowflake(bad)).toBeNull();
  }
  expect(parseSnowflake(" 42 ")).toBe(42n);
});

test("permissions: names, checks and the flag table", () => {
  expect(permissionNames("3072")).toEqual(["VIEW_CHANNEL", "SEND_MESSAGES"]);
  expect(permissionNames("0")).toEqual([]);
  expect(permissionNames("junk")).toBeNull();
  expect(hasPermission("8", "administrator")).toBe(true);
  expect(hasPermission("3072", "ADMINISTRATOR")).toBe(false);
  expect(hasPermission((1n << 51n).toString(), "PIN_MESSAGES")).toBe(true);
  expect(() => hasPermission("8", "NOPE")).toThrow(/unknown Discord permission/);
  expect(new Set(PERMISSION_FLAGS.map((f) => f.bit)).size).toBe(PERMISSION_FLAGS.length);
});

test("markup helpers", () => {
  expect(mention("user", "1")).toBe("<@1>");
  expect(mention("role", "1")).toBe("<@&1>");
  expect(mention("channel", "bad")).toBeNull();
  expect(timestampMarkdown(1767225600000)).toBe("<t:1767225600>");
  expect(timestampMarkdown(1767225600999, "R")).toBe("<t:1767225600:R>");
  expect(escapeMarkdown("*a* _b_ `c` ~d~ |e| > f")).toBe("\\*a\\* \\_b\\_ \\`c\\` \\~d\\~ \\|e\\| \\> f");
  expect(escapeMarkdown("# title\n- item")).toBe("\\# title\n\\- item");
  expect(messageUrl(null, "2", "3")).toBe("https://discord.com/channels/@me/2/3");
  expect(avatarUrl("80351110224678912", "a_x")).toBe("https://cdn.discordapp.com/avatars/80351110224678912/a_x.gif");
  expect(channelTypeName(15)).toBe("GUILD_FORUM");
  expect(channelTypeName(99)).toBeNull();
});

test("timestamp arguments: SDK milliseconds, bigint microseconds", () => {
  expect(timestampArgToMillis(1767225600123.456)).toBe(1767225600123);
  expect(timestampArgToMillis(1767225600123456n)).toBe(1767225600123);
  expect(timestampArgToMillis(new Date(5))).toBe(5);
  expect(timestampArgToMillis(null)).toBeNull();
});

test("write helpers: content checks and allowed_mentions", () => {
  expect(() => checkContent("")).toThrow(/empty/);
  expect(() => checkContent("x".repeat(2001))).toThrow(/2000/);
  // 2000 emoji are 2000 characters even though they are 4000 UTF-16 units.
  expect(checkContent("😀".repeat(2000))).toHaveLength(4000);
  expect(messageBody("hi", {})).toEqual({ content: "hi", allowed_mentions: { parse: [] } });
  expect(messageBody("hi", { allowMentions: true, replyTo: "5", tts: true })).toMatchObject({
    allowed_mentions: { parse: ["users", "roles", "everyone"] },
    message_reference: { message_id: "5" },
    tts: true,
  });
});

test("mappers tolerate missing fields", () => {
  const msg = mapMessage({ id: "175928847299117063" });
  expect(msg.created_at).toBe(1462015105796);
  expect(msg.reactions).toEqual([]);
  expect(msg.reaction_count).toBe(0);
  const member = mapMember({ user: { id: "1", username: "u", global_name: "G" }, nick: null }, "9");
  expect(member.display_name).toBe("G");
  expect(mapThread({ id: "175928847299117063", type: 11 }).type_name).toBe("PUBLIC_THREAD");
});

test("auth: secret first, then environment; trailing slash trimmed", () => {
  const saved = { token: process.env.DISCORD_BOT_TOKEN, base: process.env.DISCORD_API_BASE };
  process.env.DISCORD_BOT_TOKEN = "from-env";
  delete process.env.DISCORD_API_BASE;
  try {
    expect(resolveAuth({ s: { type: "discord", token: "from-secret", api_base: "http://x/" } })).toEqual({
      token: "from-secret",
      apiBase: "http://x",
    });
    expect(resolveAuth({})).toEqual({ token: "from-env", apiBase: "https://discord.com/api/v10" });
  } finally {
    for (const [k, v] of [
      ["DISCORD_BOT_TOKEN", saved.token],
      ["DISCORD_API_BASE", saved.base],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("routeKey keeps major parameters and collapses other ids", () => {
  expect(routeKey("GET", "/channels/123456789012345678/messages/223456789012345678")).toBe(
    "GET /channels/123456789012345678/messages/:id",
  );
});

// ------------------------------------------------------------ against the mock Discord API

describe("against the worker and the mock Discord API", () => {
  let client: VgiClient;
  let mock: ReturnType<typeof Bun.spawn>;
  let mockUrl: string;
  const GUILD = "1178847726796800002";
  const HISTORY = "1179210114662400004";

  beforeAll(async () => {
    // The mock prints PORT:<n> once it is listening; MOCK_FLAKY exercises the 429 path.
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_discord", "server.py")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MOCK_FLAKY: "1" },
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`mock API did not report a port: ${text}`);
    mockUrl = `http://127.0.0.1:${port}`;
    // A client that launches the worker as a subprocess, the way DuckDB does; credentials via env.
    client = new VgiClient(
      subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")], {
        env: { ...(process.env as Record<string, string>), DISCORD_BOT_TOKEN: "test-token", DISCORD_API_BASE: mockUrl },
      }),
    );
  });

  afterAll(() => {
    client?.close();
    mock?.kill();
  });

  async function table(name: string, positional: unknown[], named: Record<string, unknown> = {}) {
    const rows: Record<string, unknown>[] = [];
    for await (const page of client.tableFunctionRows({
      functionName: name,
      arguments: new Arguments(positional, new Map(Object.entries(named))),
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    return rows;
  }

  test("DiscordClient retries 429 and reports status + code", async () => {
    const api = new DiscordClient({ token: "test-token", apiBase: mockUrl });
    expect((await api.get<{ username: string }>("/users/@me")).username).toBe("testbot");
    await expect(api.get(`/guilds/999999999999999999`)).rejects.toThrow(/HTTP 404 \(code 10004\): Unknown Guild/);
    const anon = new DiscordClient({ token: undefined, apiBase: mockUrl });
    await expect(anon.get("/users/@me")).rejects.toThrow(/No Discord bot token/);
  });

  test("guilds: lists both fixture guilds", async () => {
    const rows = await table("guilds", []);
    expect(rows.map((r) => r.name).sort()).toEqual(["Second Guild", "Test Guild"]);
  });

  test("members: paginates past 1000 and honours max_members", async () => {
    expect((await table("members", [GUILD], { max_members: 1500n })).length).toBe(1500);
    expect((await table("members", [GUILD], { max_members: 1001n })).length).toBe(1001);
  });

  test("messages: walks all pages without duplicates", async () => {
    const rows = await table("messages", [HISTORY], { max_messages: 10_000n, before_id: null, after_id: null });
    expect(rows.length).toBe(250);
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(250);
  });
});
