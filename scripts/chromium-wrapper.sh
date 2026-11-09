#!/bin/sh
set -eu

chromium_binary=/usr/bin/chromium

# Compose host-tools sets HOME and XDG_CONFIG_HOME to host paths that the
# container's user may not be able to write. Chromium (crashpad) aborts at
# startup when its config/cache dirs are unwritable, so give it a private
# writable home in that case.
dir_ok() {
  # Unset is fine (Chromium derives it from HOME); set means it must be writable.
  [ -z "${1:-}" ] || [ -w "$1" ] || { [ ! -e "$1" ] && mkdir -p "$1" 2>/dev/null; }
}

if [ -n "${HOME:-}" ] && [ -w "$HOME" ] && dir_ok "${XDG_CONFIG_HOME:-}" && dir_ok "${XDG_CACHE_HOME:-}"; then
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
