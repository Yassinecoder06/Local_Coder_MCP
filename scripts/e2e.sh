#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Run ./scripts/setup.sh first (or create .env from .env.example)." >&2; exit 1; }

# Read only the values this script needs. Never source .env: UID is readonly in bash.
env_value() {
  awk -v key="$1" 'index($0, key "=") == 1 { sub("^[^=]*=", ""); sub("\r$", ""); print; exit }' .env
}
projects_dir=$(env_value PROJECTS_DIR)
mount_dir=$(env_value MOUNT_DIR)
mount_dir=${mount_dir:-$projects_dir}
mcp_token=$(env_value MCP_TOKEN)
: "${projects_dir:?PROJECTS_DIR is required in .env}"
: "${mcp_token:?MCP_TOKEN is required in .env}"

project="local-coder-e2e-$$"
temp_dir=$(mktemp -d)
fixture=$(mktemp "$projects_dir/.local-coder-e2e.XXXXXX")
workspace_root=$(mktemp -d "$mount_dir/.local-coder-e2e-root.XXXXXX")
headers="$temp_dir/headers"
cleanup() {
  docker compose -p "$project" --env-file .env down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$fixture"
  rm -rf "$workspace_root"
  rm -rf "$temp_dir"
}
trap cleanup EXIT
printf 'Local Coder MCP e2e fixture\n' >"$fixture"
printf 'Workspace roots E2E fixture\n' >"$workspace_root/workspace-root-e2e-marker.txt"

# The isolated project name, ports, and data path leave the user's running stack intact.
export PORT=18787 ADMIN_PORT=18788 DATA_VOLUME="$temp_dir/data"
# Create it as the host user; Docker would create a missing bind source as root.
mkdir -p "$DATA_VOLUME"
cp test/fixtures/schema-tools-mcp.mjs "$DATA_VOLUME/schema-tools-mcp.mjs"
cat >"$DATA_VOLUME/plugin-echo.mjs" <<'EOF'
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const server = new Server({ name: "local-coder-e2e-echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Return the supplied text.", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"],
  } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }],
}));
await server.connect(new StdioServerTransport());
EOF
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

# Add a local stdio fixture and verify the separate plugin MCP endpoint.
plugin_input=$(jq -cn '{id:"e2e-echo",name:"E2E Echo",enabled:true,trusted:false,transport:{type:"stdio",command:"node",args:["/data/plugin-echo.mjs"],cwd:"/data"}}')
curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
  -d "$plugin_input" "http://127.0.0.1:${ADMIN_PORT}/api/plugins" \
  | jq -e '.id == "e2e-echo" and .transport.command == "node"' >/dev/null
plugin_summary=
for attempt in $(seq 1 65); do
  plugin_summary=$(curl --silent --show-error "http://127.0.0.1:${ADMIN_PORT}/api/plugins" || true)
  if echo "$plugin_summary" | jq -e 'any(.[]; .id == "e2e-echo" and .status.state == "ready")' >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "$plugin_summary" | jq -e 'any(.[]; .id == "e2e-echo" and .status.state == "ready" and .status.toolCount == 1)' >/dev/null
echo "Admin plugin reaches Ready: ok"

plugin_base="http://127.0.0.1:${PORT}/mcp/plugins/${mcp_token}"
plugin_headers="$temp_dir/plugin-headers"
plugin_initialize=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e-plugin","version":"1.0"}}}' \
  "$plugin_base" -D "$plugin_headers")
plugin_session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$plugin_headers" | tail -n 1)
if [[ -z "$plugin_session" ]]; then plugin_session_header=(); else plugin_session_header=(-H "Mcp-Session-Id: $plugin_session"); fi
plugin_rpc() { curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${plugin_session_header[@]}" -d "$1" "$plugin_base"; }
plugin_initialize=$(json_response "$plugin_initialize")
echo "$plugin_initialize" | jq -e '.result.serverInfo.name or .result.protocolVersion' >/dev/null
plugin_rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
plugin_tools=$(json_response "$(plugin_rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')")
echo "$plugin_tools" | jq -e '[.result.tools[].name] | index("echo") != null' >/dev/null
plugin_call=$(json_response "$(plugin_rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"plugin-e2e-ok"}}}')")
echo "$plugin_call" | jq -e '.result.isError != true and any(.result.content[]; .type == "text" and .text == "plugin-e2e-ok")' >/dev/null
echo "Plugin MCP endpoint and echo call: ok"

curl --fail --silent --show-error -X PATCH -H 'Content-Type: application/json' \
  -d '{"enabled":false}' "http://127.0.0.1:${ADMIN_PORT}/api/plugins/e2e-echo/tools/echo" \
  | jq -e '.enabled == false' >/dev/null
plugin_tools=$(json_response "$(plugin_rpc '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')")
echo "$plugin_tools" | jq -e '[.result.tools[].name] | index("echo") == null' >/dev/null
echo "Disabled plugin tool is unpublished: ok"

# Exercise schema normalisation and the main-connector plugin bridge.
schema_plugin_input=$(jq -cn '{id:"e2e-schema",name:"E2E Schema",enabled:true,trusted:false,transport:{type:"stdio",command:"node",args:["/data/schema-tools-mcp.mjs"],cwd:"/data"}}')
curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
  -d "$schema_plugin_input" "$admin/api/plugins" \
  | jq -e '.id == "e2e-schema"' >/dev/null
schema_plugin_summary=
for attempt in $(seq 1 65); do
  schema_plugin_summary=$(curl --silent --show-error "$admin/api/plugins" || true)
  if echo "$schema_plugin_summary" | jq -e 'any(.[]; .id == "e2e-schema" and .status.state == "ready")' >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "$schema_plugin_summary" | jq -e 'any(.[]; .id == "e2e-schema" and .status.state == "ready" and .status.toolCount == 2)' >/dev/null
schema_plugin_detail=$(curl --fail --silent --show-error "$admin/api/plugins/e2e-schema")
echo "$schema_plugin_detail" | jq -e '
  any(.tools[]; .name == "read_probe" and .execAllowed == true and (.adjustments | type == "array" and length > 0))
  and any(.tools[]; .name == "write_probe" and .execAllowed == false)
' >/dev/null
echo "Admin schema adjustments and execAllowed: ok"

schema_plugin_tools=$(json_response "$(plugin_rpc '{"jsonrpc":"2.0","id":5,"method":"tools/list"}')")
echo "$schema_plugin_tools" | jq -e '
  ([.result.tools[].inputSchema] | tostring | (contains("exclusiveMinimum") or contains("$ref") or contains("$schema"))) | not
' >/dev/null
echo "Plugin endpoint publishes normalized schemas: ok"

main_plugin_tools=$(call_tool 11 plugin_tools '{}')
echo "$main_plugin_tools" | jq -e '(.result | tostring) | contains("e2e-schema") and contains("read_probe") and contains("write_probe")' >/dev/null
echo "Main connector plugin_tools lists the plugin: ok"

plugin_exec() {
  local id="$1" code="$2" arguments
  arguments=$(jq -cn --arg code "$code" '{code:$code}')
  call_tool "$id" exec "$arguments"
}
read_exec=$(plugin_exec 12 'const result = await plugins["e2e-schema"].read_probe({ amount: 4 }); text(result.summary);')
echo "$read_exec" | jq -e '(.result | tostring) | contains("read:4")' >/dev/null
echo "Main connector exec can call the read-only plugin tool: ok"

write_exec=$(plugin_exec 13 'const result = await plugins["e2e-schema"].write_probe({ message: "before trust" }); text(String(result.ok));')
echo "$write_exec" | jq -e '[.result | .. | strings] | any(. == "false")' >/dev/null
echo "Main connector refuses the non-read-only plugin tool: ok"

curl --fail --silent --show-error -X PATCH -H 'Content-Type: application/json' \
  -d '{"trusted":true}' "$admin/api/plugins/e2e-schema" | jq -e '.trusted == true' >/dev/null
trusted_write_exec=$(plugin_exec 14 'const result = await plugins["e2e-schema"].write_probe({ message: "after trust" }); text(result.summary);')
echo "$trusted_write_exec" | jq -e '(.result | tostring) | contains("write:after trust")' >/dev/null
echo "Trusted plugin tools are callable from the main connector: ok"

preview_payload=$(jq -cn --arg text '{"mcpServers":{"preview-plugin":{"command":"npx","args":["-y","preview-mcp@1.0.0"]}}}' '{text:$text}')
curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
  -d "$preview_payload" "$admin/api/plugins/import/preview" \
  | jq -e '.plugins | length == 1' >/dev/null
echo "Plugin config import preview: ok"

# Verify editable workspace roots against the admin contract on a mounted path.
workspace_payload=$(jq -cn --arg root "$workspace_root" '{roots:[$root],defaultWorkspace:$root}')
workspace_http=$(curl --silent --show-error -o "$temp_dir/workspaces-put.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' -X PUT -d "$workspace_payload" \
  "http://127.0.0.1:${ADMIN_PORT}/api/workspaces")
[[ "$workspace_http" == 200 ]] || { echo "Saving a mounted workspace root returned HTTP $workspace_http." >&2; exit 1; }
jq -e --arg root "$workspace_root" '.roots == [$root] and .defaultWorkspace == $root and .source == "settings"' \
  "$temp_dir/workspaces-put.json" >/dev/null
echo "Admin saves mounted workspace roots: ok"

workspace_headers="$temp_dir/workspace-headers"
workspace_initialize=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e-workspace","version":"1.0"}}}' \
  "$base" -D "$workspace_headers")
workspace_session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$workspace_headers" | tail -n 1)
if [[ -z "$workspace_session" ]]; then workspace_session_header=(); else workspace_session_header=(-H "Mcp-Session-Id: $workspace_session"); fi
workspace_rpc() { curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${workspace_session_header[@]}" -d "$1" "$base"; }
workspace_initialize=$(json_response "$workspace_initialize")
echo "$workspace_initialize" | jq -e '.result.serverInfo.name or .result.protocolVersion' >/dev/null
workspace_rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
workspace_call=$(jq -cn --arg root "$workspace_root" \
  '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"list",arguments:{path:$root,depth:1}}}')
workspace_list=$(json_response "$(workspace_rpc "$workspace_call")")
echo "$workspace_list" | jq -e '(.result | tostring) | contains("workspace-root-e2e-marker.txt")' >/dev/null
echo "MCP can list the new workspace root: ok"

outside_payload=$(jq -cn --arg root "$workspace_root" '{roots:[$root,"/etc"],defaultWorkspace:$root}')
outside_http=$(curl --silent --show-error -o "$temp_dir/workspaces-outside.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' -X PUT -d "$outside_payload" \
  "http://127.0.0.1:${ADMIN_PORT}/api/workspaces")
[[ "$outside_http" == 400 ]] || { echo "Saving an outside workspace root returned HTTP $outside_http, expected 400." >&2; exit 1; }
jq -e '(.error | strings | ascii_downcase | test("mount_dir|allowed_roots"))' \
  "$temp_dir/workspaces-outside.json" >/dev/null
echo "Admin rejects an outside workspace root: ok"

curl --fail --silent --show-error -X DELETE "http://127.0.0.1:${ADMIN_PORT}/api/workspaces" \
  | jq -e '.source == "env"' >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${ADMIN_PORT}/api/status" \
  | jq -e '.workspaceSource == "env"' >/dev/null
echo "Admin resets workspace roots to .env: ok"

# Named services are managed through run/job, and workspace selection persists per client.
service_port=18789
service_start=$(json_response "$(rpc "$(jq -cn --arg command "node -e 'require(\"http\").createServer((_,res)=>res.end(\"service-e2e-ok\")).listen($service_port,()=>console.log(\"service-e2e-ok\"))'" --argjson port "$service_port" '{jsonrpc:"2.0",id:40,method:"tools/call",params:{name:"run",arguments:{service:"e2e",command:$command,port:$port}}}')")")
echo "$service_start" | jq -e '.result and (.error | not)' >/dev/null
service_list=$(json_response "$(rpc '{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"job","arguments":{"action":"services"}}}')")
echo "$service_list" | jq -e '(.result | tostring) | contains("e2e") and contains("healthy")' >/dev/null
service_logs=$(json_response "$(rpc '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"job","arguments":{"action":"logs","service":"e2e"}}}')")
echo "$service_logs" | jq -e '(.result | tostring) | contains("service-e2e-ok")' >/dev/null
service_stop=$(json_response "$(rpc '{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"job","arguments":{"action":"stop","service":"e2e"}}}')")
echo "$service_stop" | jq -e '.result and (.error | not)' >/dev/null
echo "Named service start, health, logs, and stop: ok"

# Each session gets its own MCP session while the client identity scopes workspace memory.
gemini_headers="$temp_dir/gemini-headers"
gemini_init=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"gemini","version":"1.0"}}}' "$base" -D "$gemini_headers")
gemini_session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$gemini_headers" | tail -n 1)
gemini_session_header=(); [[ -z "$gemini_session" ]] || gemini_session_header=(-H "Mcp-Session-Id: $gemini_session")
gemini_rpc() { curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${gemini_session_header[@]}" -d "$1" "$base"; }
gemini_rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
gemini_rpc "$(jq -cn --arg path "$workspace_root" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"workspace_switch",arguments:{path:$path}}}')" >/dev/null
chatgpt_switch=$(json_response "$(rpc "$(jq -cn --arg path "$projects_dir" '{jsonrpc:"2.0",id:44,method:"tools/call",params:{name:"workspace_switch",arguments:{path:$path}}}')")")
echo "$chatgpt_switch" | jq -e '.result and (.error | not)' >/dev/null
gemini_new_headers="$temp_dir/gemini-new-headers"
gemini_new_init=$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"gemini","version":"1.0"}}}' "$base" -D "$gemini_new_headers")
gemini_new_session=$(awk 'tolower($1) == "mcp-session-id:" { gsub("\r", "", $2); print $2 }' "$gemini_new_headers" | tail -n 1)
gemini_new_header=(); [[ -z "$gemini_new_session" ]] || gemini_new_header=(-H "Mcp-Session-Id: $gemini_new_session")
gemini_new_info=$(json_response "$(curl --fail --silent --show-error -H "$auth" -H "$accept" -H 'Content-Type: application/json' "${gemini_new_header[@]}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workspace_info","arguments":{}}}' "$base")")
echo "$gemini_new_info" | jq -e --arg root "$workspace_root" '(.result | tostring) | contains($root)' >/dev/null
echo "Workspace remembered independently for Gemini and ChatGPT: ok"

unknown_tool=$(json_response "$(rpc '{"jsonrpc":"2.0","id":45,"method":"tools/call","params":{"name":"apply_patch","arguments":{}}}')")
echo "$unknown_tool" | jq -e '(.result | tostring | ascii_downcase) | contains("edit_files")' >/dev/null
echo "Unknown edit tool suggests edit_files: ok"
echo "E2E smoke test passed."
