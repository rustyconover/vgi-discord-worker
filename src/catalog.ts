/**
 * Assemble the functions into the catalog DuckDB attaches.
 *
 * To add a function: write it (see `reads.ts`, `messages.ts`, `writes.ts`,
 * `utilities.ts`), then add it to the module's exported list.
 */

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { DISCORD_SECRET_TYPE } from "./discord/api.ts";
import { MESSAGE_FUNCTIONS } from "./messages.ts";
import { CATALOG_DOC_MD, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { READ_FUNCTIONS } from "./reads.ts";
import { REFERENCE_FUNCTIONS, REFERENCE_TABLES, UTILITY_FUNCTIONS } from "./utilities.ts";
import { WRITE_FUNCTIONS } from "./writes.ts";

export const FUNCTIONS: VgiFunction[] = [
  ...READ_FUNCTIONS,
  ...MESSAGE_FUNCTIONS,
  ...WRITE_FUNCTIONS,
  ...UTILITY_FUNCTIONS,
];

interface Example {
  description: string;
  sql: string;
}

/**
 * Publish each function's examples as `vgi.example_queries` (with descriptions).
 *
 * Overloads share one SQL name, so their examples are merged per name.
 * Returns every example, for the schema-level list.
 */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const byName = new Map<string, Example[]>();
  for (const fn of functions) {
    const bucket = byName.get(fn.meta.name) ?? [];
    byName.set(fn.meta.name, bucket);
    for (const ex of fn.meta.examples ?? []) {
      if (!bucket.some((e) => e.sql === ex.sql)) bucket.push({ description: ex.description, sql: ex.sql });
    }
  }
  for (const fn of functions) {
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(byName.get(fn.meta.name)) };
  }
  return [...byName.values()].flat();
}

const ALL_EXAMPLES = [
  ...REFERENCE_TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
  ...stampExampleQueries([...FUNCTIONS, ...REFERENCE_FUNCTIONS]),
];

/** Agent tools truncate long tags, so the schema-level list is a bounded sample (one per object). */
function sampleExamples(examples: Example[], maxChars = 3500): Example[] {
  const seen = new Set<string>();
  const out: Example[] = [];
  let size = 2;
  for (const ex of examples) {
    const object = ex.sql.match(/discord\.main\.(\w+)/)?.[1] ?? ex.sql;
    if (seen.has(object)) continue;
    const cost = JSON.stringify(ex).length + 1;
    if (size + cost > maxChars) continue;
    seen.add(object);
    out.push(ex);
    size += cost;
  }
  return out;
}

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_DOC_MD,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [DISCORD_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: [...FUNCTIONS, ...REFERENCE_FUNCTIONS],
      tables: REFERENCE_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(sampleExamples(ALL_EXAMPLES)) },
    },
  ],
};
