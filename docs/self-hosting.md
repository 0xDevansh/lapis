# Self-Hosting Lapis

Lapis is an open-source, self-deployable Cloudflare application. You deploy it into your own Cloudflare account; there is no built-in billing or quota enforcement.

---

## Required Cloudflare services

| Service | Purpose | Notes |
|---|---|---|
| **Workers** | Runs the Lapis API and serves the web UI | Standard Workers plan sufficient |
| **Durable Objects** | Per-vault coordination, serialized mutations, WebSocket presence | Requires Workers Paid plan |
| **R2** | Stores latest vault content (notes, attachments) | First 10 GB/month free |
| **D1** | Relational + FTS database (auth, search index, backlinks, tags, devices) | First 5 million rows/month free |
| **KV** | Session storage for better-auth | Free tier adequate for personal use |

> **Note on Artifacts (sealed history):** Lapis uses Cloudflare Artifacts for append-only Git history. All Artifacts features are fully implemented: sealed commit timeline, debounced snapshotting after writes, and initial vault sealing from the Obsidian plugin. The `ARTIFACTS` binding must be configured in `wrangler.jsonc` before deploying.

---

## Account and project setup

### 1. Install prerequisites

```bash
node >= 20
pnpm >= 9
wrangler >= 4.97
```

### 2. Clone and install dependencies

```bash
git clone <your-fork-or-the-repo>
cd lapis
pnpm install
```

### 3. Create Cloudflare resources

Log in to your Cloudflare account, then create the required resources:

```bash
# Authenticate wrangler
npx wrangler login

# Create the R2 bucket
npx wrangler r2 bucket create lapis-vault

# Create the D1 database (note the database_id in the output)
npx wrangler d1 create lapis-db

# Create the KV namespace (note the id in the output)
npx wrangler kv namespace create lapis-kv
```

### 4. Update wrangler.jsonc with real IDs

Edit `worker/wrangler.jsonc` and replace the placeholder `"local"` values with the real IDs returned by the commands above:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "lapis-db",
    "database_id": "<your-database-id>"  // replace this
  }
],
"kv_namespaces": [
  {
    "binding": "KV",
    "id": "<your-kv-namespace-id>"  // replace this
  }
]
```

### 5. Apply the D1 schema

```bash
npx wrangler d1 execute lapis-db --remote --file=worker/src/db/schema.sql
```

### 6. Set required secrets

```bash
# A random secret used by better-auth for signing sessions
npx wrangler secret put BETTER_AUTH_SECRET
# Your deployed worker URL, e.g. https://lapis.<your-account>.workers.dev
npx wrangler secret put BETTER_AUTH_URL
```

### 7. Build and deploy

```bash
# Build the web UI first, then bundle and deploy the worker
pnpm build
npx wrangler deploy
```

After deploy, open the URL printed by wrangler. Sign up for an account, create your first web vault, and you are ready to go.

---

## Local development

Wrangler's `--local` mode (backed by Miniflare) emulates Workers, Durable Objects, R2, D1, and KV locally without a Cloudflare account. Start both the worker and the Vite dev server in parallel:

```bash
pnpm dev
```

This runs:
- `wrangler dev --local` in `worker/` on port 8787
- `vite dev` in `web/` on port 5173 (proxies `/api` to 8787)

### Local secrets

Create `worker/.dev.vars` (git-ignored):

```ini
BETTER_AUTH_SECRET=any-random-string-for-local-dev
BETTER_AUTH_URL=http://localhost:8787
```

### Applying the schema locally

The `/api/admin/migrate` endpoint applies the D1 schema during local development:

```bash
curl -X POST http://localhost:8787/api/admin/migrate
```

This endpoint is intentionally unauthenticated and only meaningful in local dev (it has no effect in production because the remote D1 database is not accessible via `--local`).

---

## Optional deployment limits

Lapis has no built-in billing or default quota enforcement. If you want to protect your Cloudflare account from runaway usage, you can set the following optional environment variables (as Worker secrets or plain vars in `wrangler.jsonc`):

| Variable | Type | Description |
|---|---|---|
| `MAX_UPLOAD_BYTES` | number | Maximum bytes per single file upload (PUT/sync). Requests exceeding this limit receive HTTP 413. |
| `MAX_VAULT_BYTES` | number | Maximum total R2 storage per vault in bytes. Requests that would exceed this limit receive HTTP 507. |

These limits are checked in the sync and vault file routes. If neither variable is set, no limits are enforced.

Example — add to `wrangler.jsonc` under `"vars"`:

```jsonc
"vars": {
  "MAX_UPLOAD_BYTES": 52428800,   // 50 MB per file
  "MAX_VAULT_BYTES": 5368709120   // 5 GB per vault
}
```

---

## Artifacts (sealed history)

Cloudflare Artifacts is the Git-backed append-only storage product Lapis uses for sealed vault history (build slices 04 and 08).

**How sealing works:**

- After every accepted file mutation (web edit, sync write, rename, delete), the VaultCoordinator schedules a 5-second debounce alarm.
- When the alarm fires, it reads the current vault content from R2 and pushes a new commit to the vault's Artifacts repo using isomorphic-git.
- The repo is named `vault-<vaultId>` in the `lapis` namespace.
- When an Obsidian plugin seeds an initial vault, calling `POST /api/sync/:vaultId/seed/complete` triggers an immediate seal (bypasses debounce).

**Token handling:**

- Artifacts tokens are created server-side and never returned to clients.
- Write tokens have a 10-minute TTL; read tokens for history browsing have a 5-minute TTL.
- The repo remote URL is cached in the VaultCoordinator's SQLite on first seal.

**Viewing history:**

- `GET /api/vaults/:id/snapshots` returns the sealed commit timeline (newest first).
- The web UI shows a collapsible "Sealed History" panel in the vault sidebar.

**Adding the Artifacts binding to your deployment:**

Ensure `wrangler.jsonc` includes:

```jsonc
"artifacts": [
  {
    "binding": "ARTIFACTS",
    "namespace": "lapis"
  }
]
```

Create the namespace in advance via Wrangler if needed:

```bash
npx wrangler artifacts namespace create lapis
```

---

## Operational recovery

### Sync projection issues

If the Durable Object for a vault gets into an inconsistent state (e.g. the manifest diverges from R2):

1. **Pull the current manifest** via `GET /api/vaults/:id/manifest` and compare with R2 contents.
2. **Re-PUT individual files** via the sync API (`PUT /api/sync/:vaultId/files/<path>`) without a base revision header — this is treated as a whole-object replace and updates both R2 and the manifest.
3. **Rebuild the search index** by re-PUTting each Markdown file; the indexer runs on every accepted write.

There is no built-in "rebuild manifest from R2" admin endpoint in the current build. If the manifest is severely corrupt, deleting and recreating the vault (and re-uploading content from a local vault or the ZIP export) is the safe recovery path.

### Sealing failures (when Artifacts is available)

Artifacts sealing failures are logged via Workers Observability (enabled in `wrangler.jsonc`). The sealing operation is a debounced background task; it does not block file operations. If sealing fails repeatedly:

1. Check the Workers log dashboard for the error (auth failure, Artifacts quota, etc.).
2. Verify the Artifacts binding and credentials are still valid.
3. Re-trigger sealing by making any accepted write to the vault — the debounce timer restarts and another seal attempt will run.
4. If sealing remains stuck, R2 holds the authoritative current state. No vault content is at risk.

### D1 outages

D1 stores auth sessions, device credentials, and the search/backlinks/tags index. During a D1 outage:

- Authenticated sessions already in KV (managed by better-auth) continue to work for the session lifetime.
- R2 vault content reads remain available.
- Search, backlinks, and tag queries will fail with HTTP 500.
- New logins, device approvals, and sync token validation will fail.

When D1 recovers, no manual recovery is needed. The search index will reflect the state at the time of the last successful write; re-indexing requires re-uploading or re-saving affected files.

---

## Account-level deployment checklist

- [ ] Workers Paid plan enabled (required for Durable Objects)
- [ ] R2 bucket `lapis-vault` created
- [ ] D1 database `lapis-db` created; schema applied
- [ ] KV namespace `lapis-kv` created
- [ ] `wrangler.jsonc` updated with real resource IDs
- [ ] `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` secrets set
- [ ] Web UI built (`pnpm build`)
- [ ] Worker deployed (`npx wrangler deploy`)
- [ ] First account registered through the web UI
- [ ] (Optional) Upload/storage limits configured
- [ ] (Optional) Artifacts binding configured when beta access is available
