#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
url=$(docker compose --profile tunnel logs tunnel 2>&1 \
  | sed -n 's/.*https:\/\/\([[:alnum:].-]*\.trycloudflare\.com\).*/https:\/\/\1/p' | tail -n 1 || true)
if [[ -z "$url" ]]; then
  echo "Quick tunnel URL is not available yet. Check: docker compose --profile tunnel logs -f tunnel" >&2
  exit 1
fi
printf '%s\n' "$url"
echo "Set PUBLIC_URL=$url in .env, then run: docker compose up -d mcp" >&2
