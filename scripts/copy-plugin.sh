#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${VAULT_PATH:-}" ]]; then
  printf 'VAULT_PATH is required. Example:\n  export VAULT_PATH="/Users/me/Documents/My Vault"\n  pnpm plugin:copy\n' >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/lapis-sync"

if [[ ! -d "$VAULT_PATH" ]]; then
  printf 'Vault path does not exist: %s\n' "$VAULT_PATH" >&2
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cp "$ROOT_DIR/plugin/main.js" "$ROOT_DIR/plugin/manifest.json" "$ROOT_DIR/plugin/styles.css" "$PLUGIN_DIR/"

printf 'Copied Lapis Sync plugin files to %s\n' "$PLUGIN_DIR"
