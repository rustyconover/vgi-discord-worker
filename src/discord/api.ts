/**
 * A small Discord REST client: authentication, retries, rate limits, errors.
 *
 * - **Credentials.** The bot token comes from a DuckDB secret
 *   (`CREATE SECRET (TYPE discord, TOKEN '...')`) if one exists, otherwise from
 *   the `DISCORD_BOT_TOKEN` environment variable. It is resolved on every call
 *   and never stored in table-function state, because state can travel back to
 *   DuckDB over HTTP.
 * - **Base URL.** `https://discord.com/api/v10` unless the secret's `api_base`
 *   or `DISCORD_API_BASE` overrides it (the tests point it at a local mock).
 * - **Rate limits.** 429s are retried after the `retry_after` Discord reports;
 *   5xx and network errors are retried with exponential backoff. When a bucket
 *   reports `X-RateLimit-Remaining: 0`, the next request on that route waits for
 *   `X-RateLimit-Reset-After` instead of provoking a 429.
 */

import { field, type SecretTypeDescriptor, schema, secretsOfType, utf8 } from "@query-farm/vgi";
import { log } from "../log.ts";
import { SOURCE_URL, VERSION } from "../meta.ts";

export const SECRET_TYPE = "discord";
export const TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";
export const API_BASE_ENV_VAR = "DISCORD_API_BASE";
export const DEFAULT_API_BASE = "https://discord.com/api/v10";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 60_000;
// Discord requires this exact shape: "DiscordBot ($url, $versionNumber)".
const USER_AGENT = `DiscordBot (${SOURCE_URL}, ${VERSION})`;

/** Registered with DuckDB so users can run CREATE SECRET (TYPE discord, TOKEN '...'). */
export const DISCORD_SECRET_TYPE: SecretTypeDescriptor = {
  name: SECRET_TYPE,
  description: "Discord bot token (and optional API base URL) used by the discord worker's API functions.",
  schema: schema([field("token", utf8(), true, new Map([["redact", "true"]])), field("api_base", utf8(), true)]),
};

export interface DiscordAuth {
  token: string | undefined;
  apiBase: string;
}

/** Resolve the token and base URL: DuckDB secret first, then the environment. */
export function resolveAuth(secrets: Record<string, Record<string, unknown>> | undefined): DiscordAuth {
  let token: string | undefined;
  let apiBase: string | undefined;
  for (const secret of secretsOfType(secrets ?? {}, SECRET_TYPE)) {
    if (!token && typeof secret.token === "string" && secret.token) token = secret.token;
    if (!apiBase && typeof secret.api_base === "string" && secret.api_base) apiBase = secret.api_base;
  }
  token ??= process.env[TOKEN_ENV_VAR] || undefined;
  apiBase ??= process.env[API_BASE_ENV_VAR] || DEFAULT_API_BASE;
  return { token, apiBase: apiBase.replace(/\/+$/, "") };
}

/** An error Discord returned (or a request we gave up on). The message always names the HTTP status. */
export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Send `Authorization: Bot <token>`. False for webhooks, whose URL carries its own token. */
  auth?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Route key for rate-limit tracking: major parameters kept, other ids collapsed. */
export function routeKey(method: string, path: string): string {
  const parts = path.split("/");
  const kept = parts.map((part, i) =>
    /^\d{15,25}$/.test(part) && !["channels", "guilds", "webhooks"].includes(parts[i - 1] ?? "") ? ":id" : part,
  );
  return `${method} ${kept.join("/")}`;
}

/** Earliest time each exhausted bucket may be used again (per process). */
const bucketResetAt = new Map<string, number>();

function buildUrl(base: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? (path.includes("?") ? "&" : "?") + qs : ""}`;
}

/** Parse Discord's error body `{message, code}`, falling back to raw text. */
function describeError(text: string): { message: string; code?: number } {
  try {
    const body = JSON.parse(text) as { message?: string; code?: number };
    if (body && typeof body.message === "string") return { message: body.message, code: body.code };
  } catch {
    // not JSON
  }
  return { message: text.slice(0, 300) };
}

export class DiscordClient {
  constructor(readonly auth: DiscordAuth) {}

  static fromSecrets(secrets: Record<string, Record<string, unknown>> | undefined): DiscordClient {
    return new DiscordClient(resolveAuth(secrets));
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  /** Send one request, retrying 429/5xx/network failures. Returns parsed JSON (or null for 204). */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const useAuth = opts.auth ?? true;
    if (useAuth && !this.auth.token) {
      throw new DiscordApiError(
        `No Discord bot token: run CREATE SECRET (TYPE ${SECRET_TYPE}, TOKEN '...') or set ${TOKEN_ENV_VAR}`,
        401,
      );
    }
    const url = buildUrl(this.auth.apiBase, path, opts.query);
    // Webhook paths carry a credential; never echo it in errors or logs.
    const shown = path.replace(/^(\/webhooks\/\d+)\/[^/?]+/, "$1/<token>");
    const display = `${method} ${shown}`;
    const key = routeKey(method, shown);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
    if (useAuth) headers.Authorization = `Bot ${this.auth.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    for (let attempt = 1; ; attempt++) {
      const waitUntil = bucketResetAt.get(key);
      if (waitUntil && waitUntil > Date.now()) await sleep(Math.min(waitUntil - Date.now(), MAX_WAIT_MS));

      let response: Response;
      try {
        response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new DiscordApiError(`Discord ${display} failed: ${(err as Error).message}`, 0);
        }
        await sleep(250 * 2 ** attempt);
        continue;
      }

      if (response.headers.get("X-RateLimit-Remaining") === "0") {
        const resetAfter = Number(response.headers.get("X-RateLimit-Reset-After") ?? "0");
        if (resetAfter > 0) bucketResetAt.set(key, Date.now() + resetAfter * 1000);
      }

      if (response.ok) {
        if (response.status === 204) return null as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      const text = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const { message, code } = describeError(text);
        const codePart = code !== undefined ? ` (code ${code})` : "";
        throw new DiscordApiError(
          `Discord ${display} failed with HTTP ${response.status}${codePart}: ${message}`,
          response.status,
          code,
        );
      }

      let delayMs = 250 * 2 ** attempt;
      if (response.status === 429) {
        let retryAfter = Number(response.headers.get("Retry-After") ?? "NaN");
        try {
          const parsed = JSON.parse(text) as { retry_after?: number };
          if (typeof parsed.retry_after === "number") retryAfter = parsed.retry_after;
        } catch {
          // keep header value
        }
        if (Number.isFinite(retryAfter)) delayMs = retryAfter * 1000;
      }
      log.debug(`${display}: HTTP ${response.status}, retrying in ${delayMs} ms`);
      await sleep(Math.min(Math.max(delayMs, 0), MAX_WAIT_MS));
    }
  }
}

/** Percent-encode a path segment (ids, emoji). */
export const seg = (value: string): string => encodeURIComponent(value);
