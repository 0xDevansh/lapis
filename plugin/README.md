# Lapis Sync

Lapis Sync connects an Obsidian Local Vault to a self-hosted Lapis Web Vault, using the external Lapis server for auth, sync coordination, search indexing, live notifications, conflict notes, and sealed history.

## Requirements

- Obsidian 1.0+
- A deployed Lapis server
- A Web Vault ID from the Lapis web app

## Install

1. Build the plugin from the repo root:

```sh
pnpm plugin:build
```

2. Create the plugin directory in your Obsidian vault:

```sh
mkdir -p /path/to/vault/.obsidian/plugins/lapis-sync
```

3. Copy the release files:

```sh
cp plugin/main.js plugin/manifest.json plugin/styles.css /path/to/vault/.obsidian/plugins/lapis-sync/
```

4. Open Obsidian, enable community plugins, then enable **Lapis Sync**.

## Quick Start

1. Open **Settings → Lapis sync**.
2. Set your Lapis server URL and Web Vault ID.
3. Run **Lapis: Connect** from the command palette.
4. Approve the displayed device code in the Lapis web app.
5. The plugin performs the first sync, then keeps the Local Vault and Web Vault synchronized.

## Development

```sh
pnpm plugin:dev
```

The plugin writes `main.js` at the plugin package root for manual Obsidian installation.
