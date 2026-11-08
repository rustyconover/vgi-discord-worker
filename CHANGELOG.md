# Changelog

## 0.1.0 (unreleased)

Discord worker, built from the VGI TypeScript starter template.

- Readers: `me`, `guilds`, `guild`, `channels`, `active_threads`, `roles`, `members`,
  `emojis`, `scheduled_events`, `messages`, `message`, `pinned_messages`, `reaction_users`.
- Writers: `send_message`, `send_messages` (table in-out), `send_webhook`, `edit_message`,
  `delete_message`, `add_reaction`. Mentions are suppressed by default.
- Utilities: snowflake decode/encode/parts, mention and timestamp markup, markdown escaping,
  message/avatar URLs, permission decoding, `permission_flags` and `channel_types` tables.
- `discord` secret type (`token`, `api_base`) with `DISCORD_BOT_TOKEN` / `DISCORD_API_BASE` fallback.
- Offline mock Discord API; SQL suite over stdio/launch/http; stock-DuckDB verification manifest.

Targets: @query-farm/vgi 0.48 · VGI protocol 3.1 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
