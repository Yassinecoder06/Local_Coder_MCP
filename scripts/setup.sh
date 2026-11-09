#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

yes_mode=false
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then yes_mode=true; fi
command -v docker >/dev/null 2>&1 || { echo "Docker is required. Install Docker Engine/Desktop with Compose v2." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }
if [[ ! -f .env ]]; then cp .env.example .env; fi

get_env() { sed -n "s/^$1=//p" .env | tail -n 1; }
set_env() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" 'BEGIN { FS=OFS="=" } $1 == k { $0=k "=" v; found=1 } { print } END { if (!found) print k "=" v }' .env >"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

token=$(get_env MCP_TOKEN)
if [[ -z "$token" ]]; then
  if command -v openssl >/dev/null 2>&1; then token=$(openssl rand -hex 32)
  else token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  fi
  set_env MCP_TOKEN "$token"
fi
projects_dir=$(get_env PROJECTS_DIR)
default_projects="$HOME/Projects"
if [[ -z "$projects_dir" || "$projects_dir" == "/home/you/Projects" ]]; then projects_dir="$default_projects"; fi
if [[ "$yes_mode" != true && -t 0 ]]; then
  read -r -p "Projects directory [$projects_dir]: " answer
  projects_dir="${answer:-$projects_dir}"
fi
projects_dir=$(mkdir -p "$projects_dir" && cd "$projects_dir" && pwd -P)
set_env PROJECTS_DIR "$projects_dir"
mount_dir=$(get_env MOUNT_DIR)
mount_default=${mount_dir:-$projects_dir}
if [[ "$yes_mode" != true && -t 0 ]]; then
  read -r -p "Folder the server may reach (default: PROJECTS_DIR) [$mount_default]: " answer
  mount_dir=${answer:-$mount_default}
else
  mount_dir=$mount_default
fi
mount_dir=$(mkdir -p "$mount_dir" && cd "$mount_dir" && pwd -P)
set_env MOUNT_DIR "$mount_dir"
# Remove legacy names that collide with Bash's readonly UID/GID variables.
sed -i '/^UID=/d; /^GID=/d' .env
set_env HOST_UID "$(id -u)"
set_env HOST_GID "$(id -g)"

herdr_bin=$(get_env HERDR_BIN)
if [[ -z "$herdr_bin" || ! -x "$herdr_bin" ]]; then
  if [[ -x "$HOME/.local/bin/herdr" ]]; then herdr_bin="$HOME/.local/bin/herdr"
  else herdr_bin=$(command -v herdr || true)
  fi
fi
if [[ -n "$herdr_bin" && -x "$herdr_bin" && -S "$HOME/.config/herdr/herdr.sock" ]]; then
  set_env HERDR_BIN "$herdr_bin"
  set_env COMPOSE_FILE "compose.yaml:compose.host-tools.yaml"
  herdr_enabled=true
else
  set_env HERDR_BIN ""
  set_env COMPOSE_FILE "compose.yaml"
  herdr_enabled=false
fi

mkdir -p data
if [[ "$herdr_enabled" == true ]]; then echo "herdr integration: enabled"; else echo "herdr integration: disabled"; fi
docker compose up -d --build
echo
admin_port=$(get_env ADMIN_PORT)
port=$(get_env PORT)
public_url=$(get_env PUBLIC_URL)
admin_port=${admin_port:-8788}
port=${port:-8787}
public_url=${public_url%/}
base_url=${public_url:-http://localhost:$port}
echo "Local Coder MCP is starting. MCP URL: ${base_url}/mcp"
echo "Open http://localhost:${admin_port} and pick your client on the Connect page."
echo "For a public Quick Tunnel, run: docker compose --profile tunnel up -d"
echo "Its URL will appear automatically in the admin UI. Set PUBLIC_URL only for named or third-party tunnels."
