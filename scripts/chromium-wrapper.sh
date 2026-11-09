#!/bin/sh
set -eu

chromium_binary=/usr/bin/chromium

# Compose host-tools can set HOME to a host path that is not writable by the
# container's user. Give Chromium a private writable home and profile then.
if [ -n "${HOME:-}" ] && [ -w "$HOME" ]; then
  exec "$chromium_binary" "$@"
fi

chromium_home=$(mktemp -d "${TMPDIR:-/tmp}/chromium-home.XXXXXX")
trap 'rm -rf "$chromium_home"' EXIT
mkdir -p "$chromium_home/config" "$chromium_home/cache" "$chromium_home/profile"
export HOME="$chromium_home"
export XDG_CONFIG_HOME="$chromium_home/config"
export XDG_CACHE_HOME="$chromium_home/cache"

has_user_data_dir=false
for arg in "$@"; do
  case "$arg" in
    --user-data-dir|--user-data-dir=*) has_user_data_dir=true ;;
  esac
done

if [ "$has_user_data_dir" = true ]; then
  "$chromium_binary" "$@"
else
  "$chromium_binary" "$@" "--user-data-dir=$chromium_home/profile"
fi
result=$?
exit "$result"
