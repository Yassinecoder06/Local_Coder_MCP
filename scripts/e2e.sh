#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Run ./scripts/setup.sh first (or create .env from .env.example)." >&2; exit 1; }

# Read only the values this script needs. Never source .env: UID is readonly in bash.
env_value() {
  awk -v key="$1" 'index($0, key "=") == 1 { sub("^[^=]*=", ""); sub("\r$", ""); print; exit }' .env
}
projects_dir=$(env_value PROJECTS_DIR)
mcp_token=$(env_value MCP_TOKEN)
: "${projects_dir:?PROJECTS_DIR is required in .env}"
: "${mcp_token:?MCP_TOKEN is required in .env}"

project="local-coder-e2e-$$"
temp_dir=$(mktemp -d)
fixture=$(mktemp "$projects_dir/.local-coder-e2e.XXXXXX")
headers="$temp_dir/headers"
cleanup() {
  docker compose -p "$project" --env-file .env down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$fixture"
  rm -rf "$temp_dir"
}
trap cleanup EXIT
printf 'Local Coder MCP e2e fixture\n' >"$fixture"

# The isolated project name, ports, and data path leave the user's running stack intact.
export PORT=18787 ADMIN_PORT=18788 DATA_VOLUME="$temp_dir/data"
# Create it as the host user; Docker would create a missing bind source as root.
mkdir -p "$DATA_VOLUME"
compose() { docker compose -p "$project" --env-file .env "$@"; }
compose build
compose up -d

for attempt in $(seq 1 60); do
  container=$(compose ps -q mcp)
  health=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
  [[ "$health" == healthy ]] && break
  [[ "$health" == unhealthy ]] && { echo "Container healthcheck failed." >&2; compose logs mcp; exit 1; }
  sleep 2
done
[[ "${health:-}" == healthy ]] || { echo "Timed out waiting for healthy MCP service." >&2; compose logs mcp; exit 1; }
echo "Container health: $health"

# Match compose.host-tools.yaml's host HOME override with a path unavailable to
# the container user. Raw Chromium should fall back to a writable temp profile.
raw_dom=$(docker exec -e HOME=/home/nonwritable "$container" chromium --headless --no-sandbox --dump-dom about:blank 2>"$temp_dir/chromium.stderr")
if ! grep -qi '<html' <<<"$raw_dom"; then
  cat "$temp_dir/chromium.stderr" >&2
  echo "Raw Chromium did not render about:blank with an unwritable HOME." >&2
  exit 1
fi
echo "Raw Chromium with unwritable HOME: ok"

base="http://127.0.0.1:${PORT}/mcp"
auth="Authorization: Bearer $mcp_token"
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
echo "MCP initialize: ok"
rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
tools=$(json_response "$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')")
echo "$tools" | jq -e '[.result.tools[].name] | index("status") != null and index("read") != null and index("browser_check") != null and index("ask_user") != null and index("user_request_status") != null and index("finish") != null' >/dev/null
status=$(json_response "$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}')")
echo "$status" | jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null
echo "MCP tools/call status: ok"

# Verify that the server records a non-default MCP client identity from initialize.
claude_headers="$temp_dir/claude-headers"
claude_initialize=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":6,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-code","version":"1.0"}}}' "$base" -D "$claude_headers")
claude_initialize=$(json_response "$claude_initialize")
echo "$claude_initialize" | jq -e '.result.serverInfo.name or .result.protocolVersion' >/dev/null
claude_session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$claude_headers" | tail -n 1)
if [[ -z "$claude_session" ]]; then claude_session_header=(); else claude_session_header=(-H "Mcp-Session-Id: $claude_session"); fi
claude_rpc() { curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${claude_session_header[@]}" -d "$1" "$base"; }
claude_rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
claude_status=$(json_response "$(claude_rpc '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"status","arguments":{}}}')")
echo "$claude_status" | jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null
echo "MCP initialize client claude-code: ok"
read_result=$(json_response "$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read\",\"arguments\":{\"paths\":[\"$fixture\"]}}}")")
echo "$read_result" | jq -e '.result and (.error | not) and (.result.isError != true) and ((.result | tostring) | contains("Local Coder MCP e2e fixture"))' >/dev/null
echo "MCP tools/call read: ok"
browser_result=$(json_response "$(rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_check","arguments":{"url":"http://127.0.0.1:8788/"}}}')")
if ! echo "$browser_result" | jq -e '.result.content | any(.[]; .type == "image" and .mimeType == "image/png")' >/dev/null; then
  echo "$browser_result" | jq 'del(.result.content[]?.data)' >&2 || echo "$browser_result" >&2
  echo "MCP browser_check did not return an image block." >&2
  exit 1
fi
echo "MCP browser_check screenshot with wrapper: ok"
curl --fail --silent --show-error "http://127.0.0.1:${ADMIN_PORT}/api/status" | jq -e '.version and .endpoints' >/dev/null
echo "Admin API: ok"
curl --fail --silent --show-error "http://127.0.0.1:${ADMIN_PORT}/api/activity" | jq -e 'any(.[]; .client == "claude-code" and .tool == "status")' >/dev/null
echo "Admin activity client claude-code: ok"

# Exercise the human request flow through MCP and the Admin API. Build arguments
# from the published schemas so this smoke test follows the tools' own field names.
admin="http://127.0.0.1:${ADMIN_PORT}"
call_tool() {
  local id="$1" name="$2" arguments="$3" payload
  payload=$(jq -cn --argjson id "$id" --arg name "$name" --argjson arguments "$arguments" \
    '{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:$name,arguments:$arguments}}')
  json_response "$(rpc "$payload")"
}
tool_properties() {
  echo "$tools" | jq -c --arg name "$1" '.result.tools[] | select(.name == $name) | .inputSchema.properties // {}'
}

ask_properties=$(tool_properties ask_user)
echo "$ask_properties" | jq -e 'has("command") and has("cwd") and has("purpose")' >/dev/null
ask_args=$(jq -cn --arg command "printf 'Local Coder E2E request\\n' > '$fixture'" \
  --arg cwd "$projects_dir" --arg purpose "Exercise the human request card flow in the isolated E2E stack." \
  --argjson files "$(jq -cn --arg fixture "$fixture" '[ $fixture ]')" --argjson properties "$ask_properties" '
    {command:$command,cwd:$cwd,purpose:$purpose}
    | if ($properties | has("expected_files")) then .expected_files=$files
      elif ($properties | has("expectedFiles")) then .expectedFiles=$files else . end
  ')
ask_result=$(call_tool 8 ask_user "$ask_args")
echo "$ask_result" | jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null
request_id=$(echo "$ask_result" | jq -er '[.result.structuredContent // {} | .. | objects | select(.status? == "open" and (.id? | type == "string")) | .id] | .[0]')
workspace_query=$(jq -rn --arg workspace "$projects_dir" '$workspace | @uri')
curl --fail --silent --show-error "$admin/api/requests?status=open&workspace=$workspace_query" \
  | jq -e --arg id "$request_id" 'any(.[]; .id == $id and .status == "open")' >/dev/null
echo "MCP ask_user and Admin request card: ok"

curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
  -d '{"status":"done","note":"Completed by the isolated E2E check."}' "$admin/api/requests/$request_id" \
  | jq -e --arg id "$request_id" '.id == $id and .status == "done"' >/dev/null
status_args=$(jq -cn --arg id "$request_id" '{ids:[$id]}')
request_status=$(call_tool 9 user_request_status "$status_args")
echo "$request_status" | jq -e '(.result.structuredContent // {}) | .. | objects | select(.status? == "done")' >/dev/null
echo "MCP user_request_status: done"

finish_properties=$(tool_properties finish)
echo "$finish_properties" | jq -e 'has("summary")' >/dev/null
finish_args=$(jq -cn --arg summary "Local Coder E2E finish report" --argjson files '[]' --argjson properties "$finish_properties" '
  {summary:$summary}
  | if ($properties | has("changed_files")) then .changed_files=$files
    elif ($properties | has("changedFiles")) then .changedFiles=$files else . end
')
finish_result=$(call_tool 10 finish "$finish_args")
echo "$finish_result" | jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null
curl --fail --silent --show-error "$admin/api/finishes?limit=20" \
  | jq -e 'any(.[]; .summary == "Local Coder E2E finish report" and (.verified | type == "boolean"))' >/dev/null
echo "MCP finish and Admin finish report: ok"
echo "E2E smoke test passed."
