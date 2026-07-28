# Lapis

My take on OwO - Obsidian without Obsidian

Lapis is a self-hosted web app that turns your Obsidian vault into a private, always-accessible web interface. Open a note from your phone, edit it from a work computer, and have it waiting in Obsidian when you get home. Everything runs on your own Cloudflare account, so your notes stay yours.

> [!NOTE]
> **Road to v0.1**: Lapis is still under development, so expect some instability. Feature requests and bug reports are welcome!
> Deployed version at https://lapis.dvenom.in

## Features

- **Web vault** — browse, search, and edit notes from any browser; no Obsidian installation needed
- **Two-way sync** — an Obsidian plugin keeps your local vault and web vault in sync; changes flow both ways
- **Markdown rendering** — wikilinks, embeds, callouts, tags, frontmatter, backlinks, and built-in themes rendered faithfully
- **Full-text search** — fast keyword search with highlighted snippets powered by SQLite FTS5
- **Conflict notes** — when edits collide, Lapis writes a human-readable conflict note instead of silently overwriting your work
- **Works offline** — the plugin queues changes locally when you're offline and replays them when you reconnect
- **Zip export** — download your entire vault as a zip at any time
- **Private by default** — email/password auth; your vault is not publicly visible

## Install the Obsidian plugin

The plugin syncs your local vault to the web. You install it manually — it is not yet listed in the Obsidian community plugin directory.

### Option 1 — Release ZIP (recommended)

> [!NOTE]
> This won't be available until v0.1 is released lol, go to Option 2

1. Go to the [latest release](https://github.com/your-org/lapis/releases/latest) and download `lapis-sync.zip`.
2. Unzip it. You'll get three files: `main.js`, `manifest.json`, `styles.css`.
3. In your vault, create the folder `.obsidian/plugins/lapis-sync/` if it doesn't exist.
4. Copy all three files into that folder.
5. Open Obsidian → **Settings → Community plugins** → toggle **Lapis Sync** on.

### Option 2 — Build from source

1. Clone this repo and install dependencies:

```sh
git clone https://github.com/0xDevansh/lapis
cd lapis
pnpm install
```

2. Copy the plugin into your vault:

```sh
export VAULT_PATH="/path/to/your-vault"
pnpm plugin:install
```

3. Open Obsidian → **Settings → Community plugins** → toggle **Lapis Sync** on.

### Connect to your web vault

After enabling the plugin:

1. Open **Settings → Lapis Sync**.
2. Set the **Server URL** (your deployed Lapis worker URL) and **Vault ID** (from the web app).
3. Run **Lapis: Connect** from the command palette (⌘P / Ctrl+P).
4. A device code will appear. Approve it in the Lapis web app under **Devices**.
5. The plugin performs an initial sync, then keeps both vaults in sync automatically.

## Deploy your own Lapis

Lapis runs entirely on Cloudflare's free tier.

### Requirements

- [Cloudflare account](https://cloudflare.com)
- Node.js 18+ and [pnpm](https://pnpm.io)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`

### 1. Clone and install

```sh
git clone https://github.com/your-org/lapis
cd lapis
pnpm install
```

### 2. Create Cloudflare resources

```sh
# Object storage for vault content
wrangler r2 bucket create lapis-vault

# SQLite database for auth, search, and metadata
# Copy the returned database_id into worker/wrangler.jsonc
wrangler d1 create lapis-db

# KV namespace for session storage
# Copy the returned id into worker/wrangler.jsonc
wrangler kv namespace create lapis-kv

# Artifacts namespace for sealed Git history
wrangler artifacts namespace create lapis
```

Open `worker/wrangler.jsonc` and paste the `database_id` and KV `id` into the right fields.

### 3. Set secrets

```sh
cd worker
wrangler secret put BETTER_AUTH_SECRET   # any random 32+ character string
wrangler secret put BETTER_AUTH_URL      # your worker URL, e.g. https://lapis.example.workers.dev
```

### 4. Run migrations

```sh
# Apply database migrations
pnpm migrate:remote
```

### 5. Build and deploy

```sh
pnpm build
cd worker && wrangler deploy
```

Open your worker URL and sign up. Your web vault is live.

## Local development

```sh
# Copy example env file and fill in values
cp worker/.dev.vars.example worker/.dev.vars

# Apply migrations to the local D1 instance
pnpm migrate

# Start everything: worker + web dev server
pnpm dev
```

Open `http://localhost:5173`, sign up, and start adding notes.

To develop the plugin alongside it:

```sh
# In a separate terminal, watch and rebuild the plugin
pnpm plugin:dev

# Copy the build into a dev vault whenever it rebuilds
export VAULT_PATH="/path/to/your-dev-vault"
pnpm plugin:copy
```

Disable and re-enable **Lapis Sync** in Obsidian to pick up rebuilt plugin files.

## API

Lapis exposes a REST API that makes it straightforward to read and write vault content programmatically. This is useful for AI agents, automation scripts, and integrations. See [`examples/`](examples/) for working code.

Key endpoints (all require a session cookie or, for the plugin, a device Bearer token):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/vaults` | List your vaults |
| `GET` | `/api/vaults/:id/manifest` | Metadata for every file in the vault |
| `GET` | `/api/vaults/:id/files/*` | Read a file by path |
| `PUT` | `/api/vaults/:id/files/*` | Create or update a file |
| `DELETE` | `/api/vaults/:id/files/*` | Delete a file |
| `GET` | `/api/vaults/:id/search?q=` | Full-text search with snippets |
| `GET` | `/api/vaults/:id/backlinks?path=` | Notes that link to a given path |
| `GET` | `/api/vaults/:id/tags` | All tags with counts |
| `GET` | `/api/vaults/:id/export` | Download vault as a zip |

## Project layout

```
worker/   Cloudflare Worker — Hono API, Durable Objects, sync, search
web/      React SPA — vault browser, Markdown renderer, CodeMirror editor
plugin/   Obsidian plugin — device-code auth and two-way sync
examples/ Example scripts and agent integrations
docs/     Build slices, ADRs, PRD, self-hosting guide
```

## Self-hosting notes

See [`docs/self-hosting.md`](docs/self-hosting.md) for guidance on Cloudflare service configuration, Artifacts setup, storage limits, and operational recovery.

## License

MIT
