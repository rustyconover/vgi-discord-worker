/**
 * The worker entry point.
 *
 *   bin/vgi-discord-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-discord-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-discord-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'discord' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-discord-worker');
 */

import { CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, { version: VERSION, doc: CATALOG_DOC_LLM, repositoryUrl: SOURCE_URL });
}
