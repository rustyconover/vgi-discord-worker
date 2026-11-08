#!/usr/bin/env bash
# Verify the worker through stock DuckDB 2.0.0 + the signed VGI extension from
# Query Farm's repository (the Haybarn-based `make test-sql` is a separate engine).
#
#   VERIFIER=/path/to/vgi-worker/scripts/verify_worker.py ci/verify-stock-duckdb.sh
#
# Starts the mock Discord API and hands its URL and test token to the worker
# through DISCORD_API_BASE / DISCORD_BOT_TOKEN, then runs vgi-worker.json.
set -euo pipefail
: "${VERIFIER:?path to verify_worker.py from the vgi-worker skill}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp)"
python3 "$REPO/test/mock_discord/server.py" >"$LOG" 2>/dev/null &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 50); do grep -q '^PORT:' "$LOG" && break; sleep 0.1; done
PORT="$(sed -n 's/^PORT:\([0-9]*\).*/\1/p' "$LOG")"
[ -n "$PORT" ] || { echo "mock API did not start"; exit 1; }
cd "$REPO"
DISCORD_BOT_TOKEN=test-token DISCORD_API_BASE="http://127.0.0.1:$PORT" \
  uv run --with duckdb==2.0.0 python "$VERIFIER" --project . --timeout 180 "$@"
