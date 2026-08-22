# Slice 16 — Plugin seed and first-sync reconcile

## What to build

On the first successful connection (or any time `Lapis: Sync now` is run and no journal exists), determine the relationship between the Local Vault and the Web Vault and bring them into a consistent state without losing data from either side.

### Seed (local → empty web vault)
- Detect an empty Web Vault by fetching `GET /api/sync/:vaultId/manifest` and checking that the manifest has zero entries.
- Walk the local vault using `vault.getFiles()`. For each file: skip Vault Internals (`.obsidian/`, `.trash/`), skip OS junk. Upload via `PUT /api/sync/:vaultId/seed/files/<path>` (raw bytes, correct Content-Type). Show progress `Notice("Lapis: seeding X / Y files")` every 20 files and at completion.
- After all files, call `POST /api/sync/:vaultId/seed/complete`. Show `Notice("Lapis: seed complete — initial history sealed")`.
- If `receiveInternals` is on, also upload `.obsidian/` contents via the same seed endpoint.
- Populate journal `fileRevisions` and `fileHashes` from the resulting manifest.

### Pull-down (empty local → populated web vault)
- Detect an empty local vault (no `.md` files).
- Fetch the full manifest. For each entry: call `GET /api/sync/:vaultId/files/<path>` and write to local via `vault.adapter.write / writeBinary`. Show progress notices. Populate journal from manifest.

### Full reconcile (both sides populated)
- Fetch server manifest. Compute SHA-256 hash for each local file.
- Union the set of paths. Classify each into: server-only / local-only / both-same / both-different.
- Server-only → pull to local. Local-only → push via `PUT /api/sync/:vaultId/files/<path>` (no base revision check needed — this is first sync so server won't have a stale revision to reject).
- Both-different → send as `POST /api/sync/:vaultId/files/<path>/patch` with `patch` (diff of empty base to client content), `clientContent`, `baseContent: ""` so the server can attempt a three-way merge. Accepted → update journal. Conflict → Conflict Note created on server; pull it down; update journal.
- After all ops complete, refresh journal from the final manifest.

## Acceptance criteria

- [x] Connecting a plugin to an empty Web Vault uploads all Vault Content files from the local vault, calls seed-complete, and the notes are visible in the Web Vault browser.
- [x] Connecting a plugin to a populated Web Vault from an empty local vault downloads all Web Vault files to local and they open correctly in Obsidian.
- [x] Connecting a plugin when both sides are populated with non-overlapping files results in both sides having all files after reconcile.
- [x] Connecting when both sides have a file at the same path with different content results in a clean merge or a Conflict Note (never a silent overwrite of either side).
- [x] OS junk files are never sent to the server during seed or reconcile.
- [x] Vault Internals are not sent during seed unless `receiveInternals` is enabled.
- [x] Journal `fileRevisions` and `fileHashes` are correctly populated after all three scenarios.
- [x] A progress notice is shown during seed and reconcile.

## Implementation notes

- Added plugin-side `SyncEngine` with `firstSync()`, local file scanning, local seed, web-to-local pull, and full first-connect reconcile.
- Added plugin-side path filtering (`isValidVaultPath`, `isVaultInternal`, `isOsJunk`), SHA-256 hashing, and journal helpers matching the worker journal shape.
- Extended `LapisClient` with manifest, file pull, seed upload, seed-complete, whole-object upload, and base-revision guarded upload.
- The plugin now runs `syncNow()` immediately after device-code approval and exposes a `Lapis: Sync now` command.
- First-connect same-path content divergence uses a stale guarded upload (`X-Base-Revision: -1`) so the server preserves the Web Vault version and creates a Conflict Note with the local version instead of silently overwriting.
- Verified with `pnpm --filter plugin run build`.

## Blocked by

- Slice 15 (plugin scaffold + connection).
- Slices 07, 08, 09 (server seed + sync endpoints) — all complete.

## Test seam

`src/sync/engine.ts` — `reconcile(localFiles, serverManifest, client, adapter)` returns the set of ops performed and their outcomes. Tested with fixture local-file maps and server-manifest objects against a mock `SyncClientInterface` and `VaultAdapter`. No Obsidian import.
