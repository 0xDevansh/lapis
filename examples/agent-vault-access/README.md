# Lapis Vault Agent

A [Project Think](https://developers.cloudflare.com/agents/harnesses/think/) agent that gives an LLM read access to a Lapis vault. Ask it questions about your notes — it can list files, read content, search for keywords, find backlinks, and explore tags.

## How it works

The agent runs as a Cloudflare Worker backed by a Durable Object (one instance per user session). It authenticates to your Lapis server with email/password on first use and caches the session. When the LLM needs information, it calls one of five vault tools that hit the Lapis REST API.

```
User message
    │
    ▼
VaultAgent (Think, Durable Object)
    │  getSystemPrompt()  → instructs the model about vault tools
    │  getTools()         → vault_list_files, vault_read_file,
    │                        vault_search, vault_get_backlinks,
    │                        vault_get_tags
    │
    ▼
Lapis REST API  (auth via email/password → session cookie)
    │
    ├── GET /api/vaults/:id/manifest       → file list
    ├── GET /api/vaults/:id/files/*        → file content
    ├── GET /api/vaults/:id/search?q=      → full-text search
    ├── GET /api/vaults/:id/backlinks?path= → backlinks
    └── GET /api/vaults/:id/tags            → tag counts
```

## Prerequisites

- A deployed Lapis server (see the [main README](../../README.md))
- A Cloudflare account with Workers AI enabled
- Node.js 18+ and npm

## Setup

### 1. Install dependencies

```sh
cd examples/agent-vault-access
npm install
```

### 2. Configure credentials

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```
LAPIS_URL=http://localhost:8787       # or your deployed Lapis URL
LAPIS_EMAIL=you@example.com
LAPIS_PASSWORD=your-password-here
LAPIS_VAULT_ID=your-vault-id-here    # from the Lapis web app URL
```

To find your vault ID: open the Lapis web app, create or open a vault — the ID appears in the URL.

### 3. Run locally

Start your Lapis server first (see the main README), then:

```sh
npm run dev
```

The agent connects to `http://localhost:5173` (or the URL Wrangler prints).

## Deploy

Set production secrets, then deploy:

```sh
wrangler secret put LAPIS_URL
wrangler secret put LAPIS_EMAIL
wrangler secret put LAPIS_PASSWORD
wrangler secret put LAPIS_VAULT_ID

npm run deploy
```

## Example conversations

**"What notes do I have about project planning?"**

The agent calls `vault_search` with the query, reads the top results with `vault_read_file`, and summarizes the relevant sections.

**"Which notes link to my 'Getting Things Done' note?"**

The agent calls `vault_get_backlinks` on `Getting Things Done.md` and lists the connecting notes.

**"Give me an overview of this vault's structure."**

The agent calls `vault_list_files` to see all paths, then `vault_get_tags` to understand the topics, and synthesizes a summary.

## Extending the agent

To add write access, add tools that call the Lapis `PUT /api/vaults/:id/files/*` endpoint. The authentication flow is the same — `this.lapisGet` can be adapted into a `lapisRequest` helper that accepts a method and body.

To connect the agent to a chat UI, use [`useAgentChat`](https://developers.cloudflare.com/agents/harnesses/think/) from `@cloudflare/ai-chat/react` — it speaks the same WebSocket protocol that Think uses out of the box.
