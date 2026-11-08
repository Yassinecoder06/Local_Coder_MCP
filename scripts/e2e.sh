#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Run ./scripts/setup.sh first (or create .env from .env.example)." >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${PROJECTS_DIR:?PROJECTS_DIR is required in .env}"
: "${MCP_TOKEN:?MCP_TOKEN is required in .env}"
fixture="$PROJECTS_DIR/.local-coder-e2e-$$.txt"
headers=$(mktemp)
cleanup() { rm -f "$fixture" "$headers"; docker compose down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
printf 'Local Coder MCP e2e fixture\n' >"$fixture"
docker compose build
docker compose up -d

for attempt in $(seq 1 60); do
  container=$(docker compose ps -q mcp)
  health=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
  [[ "$health" == healthy ]] && break
  [[ "$health" == unhealthy ]] && { echo "Container healthcheck failed." >&2; docker compose logs mcp; exit 1; }
  sleep 2
done
[[ "${health:-}" == healthy ]] || { echo "Timed out waiting for healthy MCP service." >&2; docker compose logs mcp; exit 1; }

base="http://127.0.0.1:${PORT:-8787}/mcp"
auth="Authorization: Bearer $MCP_TOKEN"
accept='Accept: application/json, text/event-stream'
initialize=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1.0"}}}' "$base" -D "$headers")
session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$headers" | tail -n 1)
if [[ -z "$session" ]]; then session_header=(); else session_header=(-H "Mcp-Session-Id: $session"); fi
rpc() { curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${session_header[@]}" -d "$1" "$base"; }
json_response() {
  if jq -e . >/dev/null 2>&1 <<<"$1"; then printf '%s\n' "$1"
  else printf '%s\n' "$1" | jq -Rr 'select(startswith("data: ")) | ltrimstr("data: ")' | jq -s 'map(fromjson) | last'
  fi
}
initialize=$(json_response "$initialize")
echo "$initialize" | jq -e '.result.serverInfo.name or .result.protocolVersion' >/dev/null
rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
tools=$(json_response "$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')")
echo "$tools" | jq -e '[.result.tools[].name] | index("status") != null and index("read") != null' >/dev/null
status=$(json_response "$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}')")
echo "$status" | jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null
read_result=$(json_response "$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read\",\"arguments\":{\"paths\":[\"$fixture\"]}}}")")
echo "$read_result" | jq -e '.result and (.error | not) and (.result.isError != true) and ((.result | tostring) | contains("Local Coder MCP e2e fixture"))' >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${ADMIN_PORT:-8788}/api/status" | jq -e '.version and .endpoints' >/dev/null
echo "E2E smoke test passed."
