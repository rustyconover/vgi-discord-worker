<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>Discord for DuckDB: a Query.Farm VGI worker written in TypeScript.</em></p>

# VGI Discord Worker

[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Read servers, channels, members and message history from Discord, and post messages
back, all from SQL. [VGI](https://query.farm/vgi) runs this worker as a separate process
and DuckDB calls its functions like built-ins; data moves as Apache Arrow batches.

## Functions

All objects live in `discord.main`. Ids are `VARCHAR` snowflakes, exactly as Discord sends
them; times are `TIMESTAMP WITH TIME ZONE`.

**Readers** (need a bot token):

| Function | Returns |
|---|---|
| `me()` | the bot account behind the token |
| `guilds()` | servers the bot is in, with approximate member/online counts |
| `guild(guild_id)` | one server's settings, boost tier, counts |
| `channels(guild_id)` | every channel, with type name, category, topic |
| `active_threads(guild_id)` | open threads and forum posts |
| `roles(guild_id)` | roles with colors and permission bit sets |
| `members(guild_id, max_members := 1000)` | members, nicknames, role ids, join dates (Server Members intent) |
| `emojis(guild_id)` | custom emojis with markup and CDN URLs |
| `scheduled_events(guild_id)` | events with status and RSVP counts |
| `messages(channel_id, max_messages := 100, before_id := NULL, after_id := NULL)` | message history, 100 per page, with reactions, mentions, attachments |
| `message(channel_id, message_id)` | one message |
| `pinned_messages(channel_id)` | pins, with `pinned_at` |
| `reaction_users(channel_id, message_id, emoji)` | who reacted with an emoji |

**Writers**: each one acts every time the query runs. Mentions never ping unless you pass `allow_mentions := true`.

| Function | Does |
|---|---|
| `send_message(channel_id, content, reply_to := NULL, allow_mentions := false, tts := false)` | posts and returns the message |
| `send_messages((SELECT channel_id, content [, reply_to] ...), fail_on_error := true, allow_mentions := false)` | posts one message per input row, returns `ok`/`error` per row |
| `send_webhook(webhook_url, content, username := NULL, avatar_url := NULL, allow_mentions := false)` | posts through a webhook (no bot needed) |
| `edit_message(channel_id, message_id, content)` | rewrites a bot message |
| `delete_message(channel_id, message_id)` | deletes a message |
| `add_reaction(channel_id, message_id, emoji)` | reacts as the bot |

**Utilities** (no token, no network): `snowflake_timestamp`, `snowflake_from_timestamp`,
`snowflake_parts`, `user_mention`, `channel_mention`, `role_mention`, `timestamp_markdown`
(1- and 2-argument forms), `escape_markdown`, `message_url`, `avatar_url`,
`permission_names`, `has_permission`, `channel_type_name`, and the tables
`permission_flags` and `channel_types`.

## Quick start

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and [uv](https://docs.astral.sh/uv/).

1. Create an application and bot at <https://discord.com/developers/applications>, copy
   the bot token, and invite the bot to your server. To read `members()` turn on the
   **Server Members** intent. To see message text, turn on **Message Content**.
2. `make build`
3. In DuckDB 2.0 (`uvx --from duckdb-cli==2.0.0 duckdb`):

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'discord' (TYPE vgi, LOCATION '/abs/path/to/discord-worker/bin/vgi-discord-worker');

CREATE SECRET (TYPE discord, TOKEN 'your-bot-token');

SELECT name, approximate_member_count FROM discord.main.guilds();
```

`LOCATION` must be an absolute path. Instead of a secret you can export
`DISCORD_BOT_TOKEN` before starting DuckDB. In later sessions, `LOAD vgi FROM query_farm`
is enough.

## Examples

```sql
-- Most active posters in #general over the last 5000 messages
SELECT author_username, count(*) AS posts
FROM discord.main.messages('<channel_id>', max_messages := 5000)
WHERE NOT author_is_bot
GROUP BY ALL ORDER BY posts DESC LIMIT 10;

-- Everything since New Year: turn a time into a snowflake cursor
SELECT created_at, author_username, content
FROM discord.main.messages('<channel_id>', max_messages := 100000,
       after_id := discord.main.snowflake_from_timestamp(TIMESTAMPTZ '2026-01-01 00:00:00+00'))
ORDER BY created_at;

-- Which emojis win in reactions?
SELECT r.emoji, sum(r.count) AS uses
FROM (SELECT UNNEST(reactions) AS r FROM discord.main.messages('<channel_id>', max_messages := 10000))
GROUP BY ALL ORDER BY uses DESC;

-- Roles that can manage messages (or are admin)
SELECT name FROM discord.main.roles('<guild_id>')
WHERE discord.main.has_permission(permissions, 'MANAGE_MESSAGES')
   OR discord.main.has_permission(permissions, 'ADMINISTRATOR');

-- Member joins per month
SELECT date_trunc('month', joined_at) AS month, count(*)
FROM discord.main.members('<guild_id>', max_members := 100000) GROUP BY ALL ORDER BY month;

-- Post a report, one message per alert row
SELECT * FROM discord.main.send_messages(
  (SELECT '<channel_id>' AS channel_id, 'Low stock: ' || sku AS content FROM inventory WHERE qty < 5),
  fail_on_error := false);
```

## Secrets and configuration

| Setting | Secret field (`TYPE discord`) | Environment variable | Default |
|---|---|---|---|
| Bot token | `token` (redacted) | `DISCORD_BOT_TOKEN` | none |
| API base URL | `api_base` | `DISCORD_API_BASE` | `https://discord.com/api/v10` |

The secret wins over the environment. The token is resolved on every call and never
stored in table-function state (state travels back to DuckDB over HTTP). Webhook
requests go to `<api base>/webhooks/<id>/<token>`, so `api_base` redirects them too.

**Rate limits.** 429 responses are retried after Discord's `retry_after`. 5xx and network
errors are retried with backoff (5 attempts, 30 s timeout per request). A bucket that
reports `X-RateLimit-Remaining: 0` makes the next request on that route wait for the
reset instead of drawing a 429.

**Errors** name the HTTP status and Discord's error code, e.g.
`Discord GET /guilds/1/channels failed with HTTP 403 (code 50001): Missing Access`.

## Project layout

```
src/
  worker.ts          # entry point: serves the catalog over stdio, --unix or --http
  catalog.ts         # assembles functions + reference tables into the catalog
  meta.ts            # catalog/schema metadata, categories, agent test tasks
  reads.ts           # guild/channel/member readers
  messages.ts        # message history, single message, pins, reaction users
  writes.ts          # send / bulk send / webhook / edit / delete / react
  utilities.ts       # pure scalars and the permission_flags / channel_types tables
  discord/api.ts     # REST client: auth, retries, rate limits, errors
  discord/table.ts   # paginated table-function helper, column specs
  discord/models.ts  # Discord JSON -> typed rows
  discord/convert.ts # snowflakes, permissions, channel types, markup
test/mock_discord/   # offline mock of the Discord API used by every test
test/sql/            # sqllogictest suite (Haybarn runner) over stdio / launch / http
tests/               # bun unit tests
vgi-worker.json      # stock-DuckDB verification manifest (ci/verify-stock-duckdb.sh)
```

## Testing

```bash
make check        # biome + tsc, unit tests, SQL tests over 3 transports, vgi-lint
make test-unit    # bun tests (pure helpers + worker subprocess against the mock API)
make test-sql     # SQL suite through haybarn-unittest against the mock API
VERIFIER=/path/to/verify_worker.py ci/verify-stock-duckdb.sh   # stock DuckDB 2.0.0
```

All tests run offline against `test/mock_discord/server.py`. The mock serves 250 messages,
1500 members, rate-limit headers and a 429 on the first GET of each URL. No test talks to
Discord. `make lint-explain` runs with no token and an unreachable API base, because the
linter probes table functions, including the writers, with their example arguments.

## Metadata and the quality score

DuckDB, agents and documentation tools discover your functions through their metadata:
titles, descriptions, argument docs, examples and keywords.
[vgi-lint](https://github.com/Query-farm/vgi-lint-check) checks it, and CI runs it on
every push. Its settings live in `vgi-lint.toml`, which `make lint-explain`,
`vgi-lint lint`, and CI all read. This template scores 100/100 with no findings.

```bash
make lint-explain                              # findings, each with its fix
make lint-explain LINT_ARGS="--format agent"   # the same, grouped for coding agents
make lint-ai                                   # optional: an agent must solve vgi-agent-tests.yaml
```

Each report also states an **assurance level**: how much was actually verified.

| Level | Reached when | Here |
|---|---|---|
| L1 structural | the static metadata is clean | workers that need real credentials (`execute: false` in CI) |
| L2 behavioural | the examples also run and return what they claim | **the CI gate** |
| L3 semantic | an agent solves the worker's own test tasks, and the docs are reviewed | `make lint-ai`, before publishing |

- **How strict.** Your copy fails on warnings (`fail_on = "warning"` in `vgi-lint.toml`).
  Raise it to `"info"` before you publish the worker for others.
- **The linter isn't pinned.** It tracks the current quality bar, so a new rule can flag
  metadata that passed yesterday. Fix it, or waive the finding.
- **Waivers.** If a finding is genuinely wrong for your worker, waive it in
  `vgi-lint.toml` with a `kind` and a `reason`.
- **Existing workers.** If you're adding this gate to a worker that already has
  findings, record them with `vgi-lint lint --baseline vgi-lint-baseline --update-baseline`
  and set `baseline` in `vgi-lint.toml`. After that, only new findings fail.

Metadata lives in `src/meta.ts` and the `tags`/`examples` of each function.

## Logging and debugging

stdout carries the Arrow protocol, so **never print to stdout**. Log to stderr instead.
Use `log` from `src/log.ts` (it writes to stderr); `--debug` or `--log-level debug` turns it up and also enables the SDK's own tracing (`VGI_DEBUG`).

- Under DuckDB (stdio/launch), worker stderr shows up in DuckDB's error messages and
  terminal.
- In Docker it goes to `docker logs`.
- `make debug` runs one query against the worker with debug logging on.

## Deploying

The same binary serves stdio (DuckDB starts it locally) or HTTP (you host it):

```bash
docker build -t vgi-discord-worker .
docker run -p 8000:8000 -e DISCORD_BOT_TOKEN=... vgi-discord-worker   # health: GET /health
```

```sql
ATTACH 'discord' (TYPE vgi, LOCATION 'https://workers.example.com/discord');
```

Put hosted workers behind TLS and authentication. See
[authentication](https://query.farm/vgi/authentication) for bearer tokens and JWTs, and
[distributing a worker](https://query.farm/vgi/distributing-a-worker) for packaging.
Pass secrets with `-e` or your platform's secret manager.

## Releasing

Push a tag like `v0.1.0`. The release workflow compiles the worker with `bun build --compile` into a standalone executable for Linux (x86-64, arm64), macOS (arm64) and Windows (x86-64), and attaches the archives to the GitHub release. Users download one file and point `LOCATION` at it, with no Bun or `node_modules` on the host. Every artifact is signed with cosign and
carries SLSA build provenance. `ci/check-version.sh` makes sure the tag matches the
version in `package.json`.

## Using with coding agents

[AGENTS.md](AGENTS.md) is written for AI coding agents (Claude Code reads it via
`CLAUDE.md`; Codex, Cursor and others read it directly). It covers the commands, the
recipe for adding a function, the metadata checklist and the sharp edges. A good first
prompt:

> Read AGENTS.md. Add a table function `invites(guild_id)` over GET /guilds/{id}/invites,
> with full metadata, mock-server fixtures and SQL tests. You're done when `make check` passes.

## Keeping up with the template

`make template-diff` shows what changed upstream (CI, docs, examples) since your copy was
made. Your copy records its template version in `.vgi-starter.json`.

## Learn more

- [What is VGI?](https://query.farm/vgi) · [Getting started](https://query.farm/vgi/getting-started) · [Building a worker](https://query.farm/vgi/building-a-worker)
- [TypeScript SDK docs](https://query.farm/vgi/docs/typescript/): [scalar tutorial](https://query.farm/vgi/docs/typescript/tutorial/scalar/), [table tutorial](https://query.farm/vgi/docs/typescript/tutorial/table/)
- [Distributing a worker](https://query.farm/vgi/distributing-a-worker) · [Choosing a language](https://query.farm/vgi/languages) · [llms.txt](https://query.farm/vgi/llms.txt)
- SDK source: [@query-farm/vgi](https://github.com/Query-farm/vgi-typescript) · RPC layer: [https://vgi-rpc-typescript.query.farm](https://vgi-rpc-typescript.query.farm)

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## Authorship & license

The starter template is written by [Query.Farm](https://query.farm) and released under
the [BSD Zero Clause License](LICENSE) (0BSD). Use it for anything, with no attribution
required. Replace this section with your own license once the code is yours.
