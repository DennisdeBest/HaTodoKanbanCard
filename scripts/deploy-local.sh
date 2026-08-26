#!/usr/bin/env bash
#
# Copy the card into a Home Assistant config directory for testing against the real
# thing. The demo page (`npm run demo`) is the faster loop; this is for the last check,
# on a real dashboard with real lists.
#
#   ./scripts/deploy-local.sh /path/to/homeassistant
#
# Home Assistant serves `config/www/` at `/local/`, so the card lands at
# /local/lovelace/todo-kanban-card.js. Register it once under
# Settings -> Dashboards -> Resources, then bump the ?v= after each copy or the
# browser will keep serving the version it already has.
set -euo pipefail

CONFIG="${1:-${HA_CONFIG:-}}"
if [[ -z "$CONFIG" ]]; then
  echo "usage: $0 /path/to/homeassistant   (or set HA_CONFIG)" >&2
  exit 2
fi
if [[ ! -f "$CONFIG/configuration.yaml" ]]; then
  echo "$CONFIG does not look like a Home Assistant config directory" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(grep -m1 -oE 'const VERSION = "[^"]+"' "$HERE/todo-kanban-card.js" | cut -d'"' -f2)"

node --check "$HERE/todo-kanban-card.js"
mkdir -p "$CONFIG/www/lovelace"
cp "$HERE/todo-kanban-card.js" "$CONFIG/www/lovelace/todo-kanban-card.js"

echo "copied v$VERSION -> $CONFIG/www/lovelace/todo-kanban-card.js"
echo "resource URL:  /local/lovelace/todo-kanban-card.js?v=$VERSION"
