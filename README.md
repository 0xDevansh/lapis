# Lapis

Access and manage your Obsidian vault from any browser. Self-hosted on Cloudflare.

## Features

- **Web vault** — browse, edit, and navigate notes without installing Obsidian
- **Markdown rendering** — wikilinks, embeds, callouts, tags, frontmatter, and built-in themes
- **Full-text search** — keyword search with snippets powered by D1 FTS
- **Backlinks and tags** — server-computed backlink graph and tag index
- **File operations** — create, edit, upload, rename, move, and delete vault content
- **Two-way sync** — Obsidian plugin connects via device-code and syncs patches in both directions
- **Sealed history** — vault changes committed to Artifacts (Git) after a debounce; per-file and whole-vault restore
- **Conflict notes** — three-way merge for stale patches; unresolvable conflicts written to `.sync-conflicts/`
- **Offline journal** — plugin queues operations locally and replays them on reconnect
- **Live presence** — WebSocket notifications, reconnect recovery, and same-file editing warnings
- **Zip export** — download latest vault content as a zip
- **Auth-gated** — email/password login via better-auth; no E2EE in first slice

## Requirements

- [Cloudflare account](https://cloudflare.com) with access to Workers, R2, D1, KV, Durable Objects, and Artifacts
- Node.js 18+ and pnpm

## Setup

### 1. Clone and install

```sh
git clone https://github.com/your-org/lapis
cd lapis
pnpm install
```

### 2. Create Cloudflare resources

```sh
# R2 bucket
wrangler r2 bucket create lapis-vault

# D1 database (copy the returned database_id into worker/wrangler.jsonc)
wrangler d1 create lapis-db

# KV namespace (copy the returned id into worker/wrangler.jsonc)
wrangler kv namespace create lapis-kv

# Artifacts namespace
wrangler artifacts namespace create lapis
```

Update `worker/wrangler.jsonc` with the `database_id` from D1 and the `id` from KV.

### 3. Set secrets

```sh
cd worker
wrangler secret put BETTER_AUTH_SECRET   # generate a random 32+ char string
wrangler secret put BETTER_AUTH_URL      # your deployed worker URL, e.g. https://lapis.example.workers.dev
```

### 4. Run migrations

For local D1:

```sh
pnpm migrate
```

For remote D1:

```sh
pnpm migrate:remote
```

### 5. Build and deploy

```sh
# Build the web frontend
cd web && pnpm build && cd ..

# Deploy
cd worker && wrangler deploy
```

## Local development

```sh
# Terminal 1 — worker (with local R2, D1, KV, DO)
cd worker
cp .dev.vars.example .dev.vars   # fill in BETTER_AUTH_SECRET and BETTER_AUTH_URL
wrangler dev

# Terminal 2 — web dev server (proxies /api to localhost:8787)
cd web
pnpm dev
```

Then open `http://localhost:5173` and sign up.

## Obsidian Plugin

The Obsidian plugin lives in [`plugin/`](plugin/). See [`plugin/README.md`](plugin/README.md) for installation and quick-start instructions.

### Dev Install

Build the plugin and copy it into a development vault:

```sh
export VAULT_PATH="/path/to/dev-vault"
pnpm plugin:install
```

Then reload Obsidian, enable **Lapis Sync**, set `http://localhost:8787` as the server URL, paste the Web Vault ID, and run **Lapis: Connect** from the command palette.

During active plugin development, run:

```sh
pnpm plugin:dev
```

After each rebuild, run `pnpm plugin:copy` and reload the plugin in Obsidian.

## Project structure

```
worker/   Cloudflare Worker — Hono API, Durable Objects, sync, search
web/      React SPA — vault browser, Markdown renderer, presence UI
plugin/   Obsidian plugin — device-code connection and Local Vault sync
docs/     Build slices, ADRs, PRD, self-hosting guide
```

## Self-hosting notes

See [`docs/self-hosting.md`](docs/self-hosting.md) for detailed guidance on required Cloudflare services, Artifacts configuration, optional upload/storage limits, and operational recovery procedures.

## License

MIT
