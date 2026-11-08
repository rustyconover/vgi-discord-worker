/**
 * Shared plumbing for the Discord table functions.
 *
 * Every API-backed table function is a paginated scan: `fetchPage` asks
 * Discord for one page using a string cursor and returns rows plus the next
 * cursor (or null when done). This module turns that into a VGI table function
 * that streams one page per Arrow batch, carries only `{cursor, emitted, done}`
 * in its state (no secrets), honours a row limit, and resolves the `discord`
 * secret on bind.
 *
 * Columns are declared once as `ColumnSpec`s: the same list builds the Arrow
 * schema (with comments for DESCRIBE) and the `vgi.result_columns_schema` tag.
 */

import type { ArgumentConstraints } from "@query-farm/vgi";
import {
  batchFromColumns,
  bool,
  defineTableFunction,
  type FunctionExample,
  field,
  int32,
  int64,
  list,
  schema,
  struct,
  timestampMillis,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { type Category, objectTags } from "../meta.ts";
import { DiscordClient, SECRET_TYPE } from "./api.ts";

export type SqlType = "VARCHAR" | "BIGINT" | "INTEGER" | "BOOLEAN" | "TIMESTAMPTZ" | "VARCHAR[]" | "REACTIONS";

export interface ColumnSpec {
  name: string;
  type: SqlType;
  doc: string;
  nullable?: boolean;
}

const REACTION_STRUCT = struct([field("emoji", utf8(), true), field("count", int32, true)]);

const ARROW: Record<SqlType, () => VgiDataType> = {
  VARCHAR: utf8,
  BIGINT: int64,
  INTEGER: () => int32,
  BOOLEAN: () => bool,
  TIMESTAMPTZ: () => timestampMillis("UTC"),
  "VARCHAR[]": () => list(utf8()),
  REACTIONS: () => list(REACTION_STRUCT),
};

const SQL_NAME: Record<SqlType, string> = {
  VARCHAR: "VARCHAR",
  BIGINT: "BIGINT",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  TIMESTAMPTZ: "TIMESTAMP WITH TIME ZONE",
  "VARCHAR[]": "VARCHAR[]",
  REACTIONS: "STRUCT(emoji VARCHAR, count INTEGER)[]",
};

/** Build an Arrow schema whose field comments show up in DESCRIBE and agent tools. */
export function schemaOf(columns: readonly ColumnSpec[]): VgiSchema {
  return schema(columns.map((c) => field(c.name, ARROW[c.type](), c.nullable ?? true, new Map([["comment", c.doc]]))));
}

/** The `vgi.result_columns_schema` tag value for a column list. */
export function resultColumnsTag(columns: readonly ColumnSpec[]): string {
  return JSON.stringify(columns.map((c) => ({ name: c.name, type: SQL_NAME[c.type], description: c.doc })));
}

export type Row = Record<string, unknown>;

/** Turn row objects into a batch with exactly the (possibly projected) output schema's columns. */
export function rowsToBatch(rows: readonly Row[], outputSchema: VgiSchema) {
  const columns: Record<string, unknown[]> = {};
  for (const f of outputSchema.fields) columns[f.name] = rows.map((r) => r[f.name] ?? null);
  return batchFromColumns(columns, outputSchema);
}

export interface PageContext<A> {
  args: A;
  client: DiscordClient;
  /** "" on the first call, then whatever the previous page returned as `next`. */
  cursor: string;
  /** Rows emitted so far. */
  emitted: number;
  /** Rows still wanted before the limit is reached (Infinity when unlimited). */
  remaining: number;
}

export interface Page {
  rows: Row[];
  /** Cursor for the next page, or null when there is nothing more. */
  next: string | null;
}

/** Cursor state that travels with each batch. Plain and secret-free. */
interface ScanState {
  cursor: string;
  emitted: number;
  done: boolean;
}

export interface DocSpec {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}

export interface DiscordTableConfig<A> {
  name: string;
  description: string;
  args?: Record<string, VgiDataType>;
  argDefaults?: Record<string, unknown>;
  argDocs?: Record<string, string>;
  argConstraints?: Record<string, ArgumentConstraints>;
  columns: readonly ColumnSpec[];
  /** Maximum rows to return for these arguments; omit for "all". */
  limit?: (args: A) => number;
  /** Re-check arguments the SDK may not enforce (e.g. NULL-able named args). Throw to reject. */
  validate?: (args: A) => void;
  fetchPage: (ctx: PageContext<A>) => Promise<Page>;
  doc: DocSpec;
  examples: FunctionExample[];
  extraTags?: Record<string, string>;
}

/** Define a Discord-backed table function that streams one API page per batch. */
export function defineDiscordTable<A>(config: DiscordTableConfig<A>): VgiFunction {
  const outputSchema = schemaOf(config.columns);
  return defineTableFunction<A, ScanState>({
    name: config.name,
    description: config.description,
    args: config.args ?? {},
    argDefaults: config.argDefaults,
    argDocs: config.argDocs,
    argConstraints: config.argConstraints,

    // First bind asks DuckDB for any `discord` secret; the second receives it.
    onBind: (params) => {
      config.validate?.(params.args);
      return params.resolvedSecretsProvided ? { outputSchema } : { outputSchema, lookupSecretTypes: [SECRET_TYPE] };
    },

    initialState: () => ({ cursor: "", emitted: 0, done: false }),

    process: async (params, state, out) => {
      const limit = config.limit?.(params.args) ?? Number.POSITIVE_INFINITY;
      if (state.done || state.emitted >= limit) {
        out.finish();
        return;
      }
      const page = await config.fetchPage({
        args: params.args,
        client: DiscordClient.fromSecrets(params.secrets),
        cursor: state.cursor,
        emitted: state.emitted,
        remaining: limit - state.emitted,
      });
      const rows = page.rows.slice(0, Math.max(0, limit - state.emitted));
      out.emit(rowsToBatch(rows, params.outputSchema));
      state.emitted += rows.length;
      state.cursor = page.next ?? "";
      state.done = page.next === null || page.rows.length === 0;
    },

    tags: {
      ...objectTags(config.doc),
      "vgi.result_columns_schema": resultColumnsTag(config.columns),
      ...config.extraTags,
    },
    examples: config.examples,
  });
}

/** A single API call that yields its rows in one batch (no pagination). */
export function onePage(rows: Row[]): Page {
  return { rows, next: null };
}
