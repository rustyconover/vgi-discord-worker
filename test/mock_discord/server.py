#!/usr/bin/env python3
"""An offline, dependency-free mock of the parts of the Discord REST API (v10) the worker uses.

The tests point the worker at this server (secret ``API_BASE`` or ``DISCORD_API_BASE``)
so the suite is deterministic and needs no real bot.

Fixture
-------
* Bot user ``BOT_ID`` (token ``test-token``; every route except webhooks needs
  ``Authorization: Bot test-token``, else 401).
* Guild ``GUILD_ID`` ("Test Guild"): 5 channels, 2 active threads, 3 roles,
  1500 members (ids ascending, first 3 are bots, every 10th has the Moderator role),
  3 emojis, 2 scheduled events. Guild ``GUILD2_ID`` ("Second Guild") is small.
* Channel ``HISTORY_CHANNEL_ID``: 250 messages, one per minute from
  2025-01-01T00:00Z, ``content`` = ``message <n>``; every 50th pinned; message 250
  has reactions 👍 x3 and party:EMOJI x1; message 2 replies to message 1.
* Channel ``POST_CHANNEL_ID``: starts empty; POSTs land here.
* Webhook ``/webhooks/WEBHOOK_ID/whtoken``.

Behaviour switches
------------------
* ``MOCK_FLAKY=1``: the first request for each distinct method+URL answers 429
  with ``retry_after`` 0.01, exercising the client's retry path.

Usage::

    python3 test/mock_discord/server.py      # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

TOKEN = "test-token"
EPOCH = 1420070400000
BASE_MS = 1735689600000  # 2025-01-01T00:00:00Z


def snowflake(ms: int, inc: int = 0) -> str:
    return str(((ms - EPOCH) << 22) | inc)


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


BOT_ID = snowflake(BASE_MS - 86_400_000 * 300, 1)
GUILD_ID = snowflake(BASE_MS - 86_400_000 * 400, 2)
GUILD2_ID = snowflake(BASE_MS - 86_400_000 * 200, 3)
HISTORY_CHANNEL_ID = snowflake(BASE_MS - 86_400_000 * 399, 4)
POST_CHANNEL_ID = snowflake(BASE_MS - 86_400_000 * 399, 5)
CATEGORY_ID = snowflake(BASE_MS - 86_400_000 * 399, 6)
VOICE_ID = snowflake(BASE_MS - 86_400_000 * 399, 7)
FORUM_ID = snowflake(BASE_MS - 86_400_000 * 399, 8)
ADMIN_ROLE_ID = snowflake(BASE_MS - 86_400_000 * 398, 9)
MOD_ROLE_ID = snowflake(BASE_MS - 86_400_000 * 398, 10)
EMOJI_ID = snowflake(BASE_MS - 86_400_000 * 397, 11)
WEBHOOK_ID = snowflake(BASE_MS - 86_400_000 * 396, 12)

BOT = {"id": BOT_ID, "username": "testbot", "global_name": None, "discriminator": "0", "bot": True, "avatar": None}


def user(i: int) -> dict:
    uid = snowflake(BASE_MS - 86_400_000 * 100 + i * 1000, 0)
    return {
        "id": uid,
        "username": f"user{i:04d}",
        "global_name": f"User {i}" if i % 2 == 0 else None,
        "discriminator": "0",
        "bot": i < 3,
        "avatar": f"hash{i}" if i % 3 == 0 else None,
    }


USERS = [user(i) for i in range(1500)]
AUTHORS = USERS[3:6]

GUILDS = [
    {
        "id": GUILD_ID, "name": "Test Guild", "icon": "gicon", "owner": False, "permissions": "2147483647",
        "features": ["COMMUNITY", "NEWS"], "approximate_member_count": 1500, "approximate_presence_count": 321,
    },
    {
        "id": GUILD2_ID, "name": "Second Guild", "icon": None, "owner": True, "permissions": "8",
        "features": [], "approximate_member_count": 12, "approximate_presence_count": 4,
    },
]

CHANNELS = [
    {"id": CATEGORY_ID, "type": 4, "guild_id": GUILD_ID, "name": "Text Channels", "position": 0, "parent_id": None},
    {"id": HISTORY_CHANNEL_ID, "type": 0, "guild_id": GUILD_ID, "name": "general", "position": 1,
     "parent_id": CATEGORY_ID, "topic": "General chat", "nsfw": False, "rate_limit_per_user": 0,
     "last_message_id": None},
    {"id": POST_CHANNEL_ID, "type": 5, "guild_id": GUILD_ID, "name": "announcements", "position": 2,
     "parent_id": CATEGORY_ID, "topic": None, "nsfw": False},
    {"id": VOICE_ID, "type": 2, "guild_id": GUILD_ID, "name": "Lounge", "position": 3, "parent_id": None,
     "bitrate": 64000, "user_limit": 10},
    {"id": FORUM_ID, "type": 15, "guild_id": GUILD_ID, "name": "help", "position": 4, "parent_id": None,
     "nsfw": False},
]

THREADS = [
    {"id": snowflake(BASE_MS + 3_600_000, 20), "type": 11, "guild_id": GUILD_ID, "parent_id": FORUM_ID,
     "name": "How do I install?", "owner_id": AUTHORS[0]["id"], "message_count": 12, "member_count": 4,
     "applied_tags": ["1", "2"], "thread_metadata": {"archived": False, "locked": False,
     "auto_archive_duration": 1440, "archive_timestamp": iso(BASE_MS + 3_600_000),
     "create_timestamp": iso(BASE_MS + 3_600_000)}},
    {"id": snowflake(BASE_MS + 7_200_000, 21), "type": 11, "guild_id": GUILD_ID, "parent_id": HISTORY_CHANNEL_ID,
     "name": "Off topic", "owner_id": AUTHORS[1]["id"], "message_count": 3, "member_count": 2,
     "thread_metadata": {"archived": False, "locked": True, "auto_archive_duration": 60,
     "archive_timestamp": iso(BASE_MS + 7_200_000)}},
]

ROLES = [
    {"id": GUILD_ID, "name": "@everyone", "color": 0, "hoist": False, "position": 0, "permissions": "3072",
     "managed": False, "mentionable": False},
    {"id": ADMIN_ROLE_ID, "name": "Admin", "color": 15158332, "hoist": True, "position": 2, "permissions": "8",
     "managed": False, "mentionable": False},
    {"id": MOD_ROLE_ID, "name": "Moderator", "color": 3447003, "hoist": True, "position": 1,
     "permissions": "268443650", "managed": False, "mentionable": True},
]

MEMBERS = [
    {"user": u, "nick": f"nick{i}" if i % 5 == 0 else None, "roles": [MOD_ROLE_ID] if i % 10 == 0 else [],
     "joined_at": iso(BASE_MS - 86_400_000 * 90 + i * 3_600_000), "premium_since": None, "pending": False,
     "communication_disabled_until": None}
    for i, u in enumerate(USERS)
]

EMOJIS = [
    {"id": EMOJI_ID, "name": "party", "animated": False, "available": True, "managed": False, "roles": [],
     "require_colons": True, "user": {"id": AUTHORS[0]["id"]}},
    {"id": snowflake(BASE_MS - 86_400_000 * 397, 13), "name": "dance", "animated": True, "available": True,
     "managed": False, "roles": [], "require_colons": True},
    {"id": snowflake(BASE_MS - 86_400_000 * 397, 14), "name": "modonly", "animated": False, "available": True,
     "managed": False, "roles": [MOD_ROLE_ID], "require_colons": True},
]

EVENTS = [
    {"id": snowflake(BASE_MS, 30), "guild_id": GUILD_ID, "name": "Community Call", "description": "Monthly call",
     "status": 1, "entity_type": 2, "channel_id": VOICE_ID, "creator_id": AUTHORS[0]["id"], "user_count": 42,
     "scheduled_start_time": "2026-12-01T18:00:00+00:00", "scheduled_end_time": None, "entity_metadata": None},
    {"id": snowflake(BASE_MS, 31), "guild_id": GUILD_ID, "name": "Meetup", "description": None, "status": 3,
     "entity_type": 3, "channel_id": None, "creator_id": AUTHORS[1]["id"], "user_count": 7,
     "scheduled_start_time": "2025-06-01T18:00:00+00:00", "scheduled_end_time": "2025-06-01T21:00:00+00:00",
     "entity_metadata": {"location": "Berlin"}},
]


def message(n: int) -> dict:
    ms = BASE_MS + (n - 1) * 60_000
    m = {
        "id": snowflake(ms, n), "channel_id": HISTORY_CHANNEL_ID, "author": AUTHORS[n % 3],
        "content": f"message {n}", "timestamp": iso(ms), "edited_timestamp": None, "tts": False,
        "mention_everyone": False, "mentions": [], "mention_roles": [], "attachments": [], "embeds": [],
        "pinned": n % 50 == 0, "type": 0, "flags": 0,
    }
    if n == 2:
        m["type"] = 19
        m["message_reference"] = {"message_id": snowflake(BASE_MS, 1), "channel_id": HISTORY_CHANNEL_ID}
    if n == 250:
        m["reactions"] = [{"emoji": {"id": None, "name": "👍"}, "count": 3},
                          {"emoji": {"id": EMOJI_ID, "name": "party"}, "count": 1}]
        m["attachments"] = [{"id": "1", "url": "https://cdn.discordapp.com/attachments/x/report.csv"}]
        m["mentions"] = [AUTHORS[0]]
    return m


lock = threading.Lock()
MESSAGES: dict[str, list[dict]] = {HISTORY_CHANNEL_ID: [message(n) for n in range(1, 251)], POST_CHANNEL_ID: []}
POST_SEQ = [0]
FLAKY_SEEN: set[str] = set()


def new_message(channel_id: str, author: dict, body: dict, webhook_id: str | None = None) -> dict:
    POST_SEQ[0] += 1
    ms = BASE_MS + 86_400_000 * 30 + POST_SEQ[0] * 1000
    parse = (body.get("allowed_mentions") or {}).get("parse", ["users", "roles", "everyone"])
    content = body.get("content", "")
    msg = {
        "id": snowflake(ms, POST_SEQ[0] & 0xFFF), "channel_id": channel_id, "author": author, "content": content,
        "timestamp": iso(ms), "edited_timestamp": None, "tts": bool(body.get("tts", False)),
        "mention_everyone": "everyone" in parse and "@everyone" in content,
        "mentions": [], "mention_roles": [], "attachments": [], "embeds": [], "pinned": False, "type": 0, "flags": 0,
    }
    ref = body.get("message_reference")
    if ref:
        msg["type"] = 19
        msg["message_reference"] = {"message_id": ref["message_id"], "channel_id": channel_id}
    if webhook_id:
        msg["webhook_id"] = webhook_id
    return msg


def sf(x: str) -> int:
    return int(x)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        sys.stderr.write("mock_discord: " + (format % args) + "\n")

    def _send(self, status: int, body: object | None = None, headers: dict[str, str] | None = None) -> None:
        payload = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status: int, message: str, code: int = 0) -> None:
        self._send(status, {"message": message, "code": code})

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}") if length else {}

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def _handle(self, method: str) -> None:
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.strip("/").split("/")]
        q = {k: v[0] for k, v in parse_qs(url.query).items()}

        if os.environ.get("MOCK_FLAKY") == "1" and method == "GET":
            key = f"{method} {self.path}"
            with lock:
                if key not in FLAKY_SEEN:
                    FLAKY_SEEN.add(key)
                    self._send(429, {"message": "You are being rate limited.", "retry_after": 0.01, "global": False},
                               {"Retry-After": "1"})
                    return

        if parts[:1] == ["webhooks"]:
            self._webhook(method, parts, q)
            return
        if self.headers.get("Authorization") != f"Bot {TOKEN}":
            self._error(401, "401: Unauthorized")
            return
        try:
            self._route(method, parts, q)
        except KeyError:
            self._error(404, "404: Not Found")

    def _webhook(self, method: str, parts: list[str], q: dict) -> None:
        if method != "POST" or len(parts) != 3 or parts[1] != WEBHOOK_ID:
            self._error(404, "Unknown Webhook", 10015)
            return
        if parts[2] != "whtoken":
            self._error(401, "Invalid Webhook Token", 50027)
            return
        body = self._body()
        author = {"id": WEBHOOK_ID, "username": body.get("username") or "Captain Hook", "bot": True,
                  "discriminator": "0000", "avatar": None, "global_name": None}
        with lock:
            msg = new_message(POST_CHANNEL_ID, author, body, webhook_id=WEBHOOK_ID)
        if q.get("wait") == "true":
            self._send(200, msg)
        else:
            self._send(204)

    def _route(self, method: str, p: list[str], q: dict) -> None:
        n = len(p)
        if p == ["users", "@me"] and method == "GET":
            self._send(200, BOT)
        elif p == ["users", "@me", "guilds"] and method == "GET":
            after = sf(q.get("after", "0"))
            limit = int(q.get("limit", "200"))
            rows = [g for g in GUILDS if sf(g["id"]) > after][:limit]
            if q.get("with_counts") != "true":
                rows = [{k: v for k, v in g.items() if not k.startswith("approximate")} for g in rows]
            self._send(200, rows)
        elif n >= 2 and p[0] == "guilds":
            self._guild(method, p, q)
        elif n >= 2 and p[0] == "channels":
            self._channel(method, p, q)
        else:
            self._error(404, "404: Not Found")

    def _guild(self, method: str, p: list[str], q: dict) -> None:
        gid = p[1]
        if gid == GUILD2_ID and len(p) > 2:
            self._error(403, "Missing Access", 50001)
            return
        guild = next((g for g in GUILDS if g["id"] == gid), None)
        if guild is None:
            self._error(404, "Unknown Guild", 10004)
            return
        sub = p[2:]
        if sub == []:
            detail = {
                "id": gid, "name": guild["name"], "description": "A guild for tests", "owner_id": AUTHORS[0]["id"],
                "icon": guild["icon"], "verification_level": 2, "explicit_content_filter": 2, "mfa_level": 1,
                "nsfw_level": 0, "premium_tier": 2, "premium_subscription_count": 9, "preferred_locale": "en-US",
                "vanity_url_code": None, "afk_channel_id": VOICE_ID, "system_channel_id": HISTORY_CHANNEL_ID,
                "rules_channel_id": None, "features": guild["features"], "max_members": 500000,
                "roles": ROLES, "emojis": EMOJIS,
            }
            if q.get("with_counts") == "true":
                detail["approximate_member_count"] = guild["approximate_member_count"]
                detail["approximate_presence_count"] = guild["approximate_presence_count"]
            self._send(200, detail)
        elif sub == ["channels"]:
            self._send(200, CHANNELS)
        elif sub == ["threads", "active"]:
            self._send(200, {"threads": THREADS, "members": []})
        elif sub == ["roles"]:
            self._send(200, ROLES)
        elif sub == ["members"]:
            limit = int(q.get("limit", "1"))
            if not 1 <= limit <= 1000:
                self._error(400, "Invalid Form Body", 50035)
                return
            after = sf(q.get("after", "0"))
            rows = [m for m in MEMBERS if sf(m["user"]["id"]) > after][:limit]
            # Exhaust the bucket so the client has to wait for the reset before the next page.
            self._send(200, rows, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.02"})
        elif sub == ["emojis"]:
            self._send(200, EMOJIS)
        elif sub == ["scheduled-events"]:
            events = EVENTS if q.get("with_user_count") == "true" else [
                {k: v for k, v in e.items() if k != "user_count"} for e in EVENTS]
            self._send(200, events)
        else:
            self._error(404, "404: Not Found")

    def _channel(self, method: str, p: list[str], q: dict) -> None:
        cid = p[1]
        with lock:
            msgs = MESSAGES.get(cid)
        if msgs is None:
            self._error(404, "Unknown Channel", 10003)
            return
        sub = p[2:]
        if sub == ["messages"] and method == "GET":
            limit = int(q.get("limit", "50"))
            if not 1 <= limit <= 100:
                self._error(400, "Invalid Form Body", 50035)
                return
            ordered = sorted(msgs, key=lambda m: sf(m["id"]))
            if "after" in q:
                rows = [m for m in ordered if sf(m["id"]) > sf(q["after"])][:limit]
            else:
                before = sf(q["before"]) if "before" in q else 1 << 64
                rows = [m for m in ordered if sf(m["id"]) < before][-limit:]
            self._send(200, list(reversed(rows)))
        elif sub == ["messages"] and method == "POST":
            body = self._body()
            content = body.get("content") or ""
            if not content or len(content) > 2000:
                self._error(400, "Invalid Form Body", 50035)
                return
            with lock:
                msg = new_message(cid, BOT, body)
                msgs.append(msg)
            self._send(200, msg)
        elif sub == ["messages", "pins"] and method == "GET":
            pinned = sorted((m for m in msgs if m["pinned"]), key=lambda m: sf(m["id"]), reverse=True)
            items = [{"pinned_at": iso(BASE_MS + 86_400_000 + sf(m["id"]) % 1000 + i), "message": m}
                     for i, m in enumerate(pinned)]
            items.sort(key=lambda it: it["pinned_at"], reverse=True)
            if "before" in q:
                items = [it for it in items if it["pinned_at"] < q["before"]]
            limit = int(q.get("limit", "50"))
            self._send(200, {"items": items[:limit], "has_more": len(items) > limit})
        elif len(sub) >= 2 and sub[0] == "messages":
            mid = sub[1]
            msg = next((m for m in msgs if m["id"] == mid), None)
            if msg is None:
                self._error(404, "Unknown Message", 10008)
                return
            rest = sub[2:]
            if rest == [] and method == "GET":
                self._send(200, msg)
            elif rest == [] and method == "PATCH":
                if msg["author"]["id"] != BOT_ID:
                    self._error(403, "Cannot edit a message authored by another user", 50005)
                    return
                msg["content"] = self._body().get("content", msg["content"])
                msg["edited_timestamp"] = iso(BASE_MS + 86_400_000 * 31)
                self._send(200, msg)
            elif rest == [] and method == "DELETE":
                with lock:
                    msgs.remove(msg)
                self._send(204)
            elif len(rest) == 2 and rest[0] == "reactions" and method == "GET":
                emoji = rest[1]
                users = AUTHORS if emoji == "👍" else ([AUTHORS[0]] if emoji == f"party:{EMOJI_ID}" else [])
                after = sf(q.get("after", "0"))
                limit = int(q.get("limit", "25"))
                self._send(200, [u for u in users if sf(u["id"]) > after][:limit])
            elif len(rest) == 3 and rest[0] == "reactions" and rest[2] == "@me" and method == "PUT":
                self._send(204)
            else:
                self._error(404, "404: Not Found")
        else:
            self._error(404, "404: Not Found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--print-ids", action="store_true", help="print fixture ids as JSON and exit")
    args = parser.parse_args()
    if args.print_ids:
        print(json.dumps({k: v for k, v in globals().items() if k.endswith("_ID")}))
        return
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
