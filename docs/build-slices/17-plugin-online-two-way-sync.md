# Slice 17 — Plugin online two-way sync

## What to build

Keep the Local Vault and Web Vault in sync while the device is online. Changes in either direction should appear on the other side within a few seconds.

### Local → server (push)
- Register `vault.on('create' | 'modify' | 'delete' | 'rename')` via `this.registerEvent()`.
- Per-path debounce of 500 ms on `modify` to avoid sending partial saves.
- Before processing any event, filter through `isVaultInternal`, `isOsJunk`, `isValidVaultPath` (client-side mirrors of server path rules).
- **Create / modify (text):** read current content, look up `fileRevisions[lcPath]` as `baseRevision`, call `createPatch(base, current)`, send `POST /api/sync/:vaultId/files/<path>/patch` with `{patch, baseRevision, clientContent: current}`. On 200 (accepted or merged): update journal revision and hash. On 409 (stale, no merge attempted): server will have returned `serverRevision`; re-fetch from server and apply locally (server wins on this particular race).
- **Create / modify (binary):** detect binary by extension list or failed UTF-8 decode. Read via `vault.readBinary`, send `PUT /api/sync/:vaultId/files/<path>` with `X-Base-Revision` header. On 202 conflict: pull the Conflict Note.
- **Rename / move:** send `PATCH /api/sync/:vaultId/files/<oldPath>` with `{newPath}`.
- **Delete:** send `DELETE /api/sync/:vaultId/files/<path>`. Update journal (remove key).

### Server → local (pull)
- Periodic full-scan fallback: `registerInterval` every 5 minutes. Fetch manifest. For each path where server revision > journal revision: pull file, write locally, update journal.
- Direct pull on notification (wired in Slice 19). In this slice, the periodic scan is the only pull trigger.
- When writing a pulled file that already exists locally with unsaved local changes: overwrite and update journal (the notification path in Slice 19 will have revision-based echo suppression; here we trust the manifest is authoritative).

### Sync engine state
- `SyncEngine.push(event)` — processes a single watcher event.
- `SyncEngine.pullAll(manifest)` — reconciles local state against a given manifest snapshot.
- `SyncEngine.isOnline: boolean` — flipped by net errors; when false, events are appended to `pendingOps` instead of sent (full offline path in Slice 18).

### Status bar
- Shows `Lapis: syncing…` while any push or pull is in flight. Returns to `Lapis: connected` when queue drains.
- Shows `Lapis: error — tap to retry` on repeated push failure.

### Manual command
- `Lapis: Sync now` — triggers `pullAll` immediately against a freshly fetched manifest.

## Acceptance criteria

- [ ] Saving a note in Obsidian sends a patch to the server within 1 s (after debounce). The note is visible in the Web Vault browser.
- [ ] Creating a new note in Obsidian causes it to appear in the Web Vault.
- [ ] Renaming a note in Obsidian renames it in the Web Vault (not a delete + create).
- [ ] Deleting a note in Obsidian deletes it from the Web Vault.
- [ ] Uploading a binary attachment in Obsidian uploads it to the Web Vault as a whole object.
- [ ] A note created or edited in the Web Vault is pulled to local within 5 minutes (periodic scan). Its content is correct in Obsidian.
- [ ] `Lapis: Sync now` command forces an immediate pull.
- [ ] OS junk file events are silently ignored and no network request is made.
- [ ] Status bar shows syncing state while a push is in flight.
- [ ] Journal `fileRevisions` and `fileHashes` are correct after every accepted push and pull.

## Blocked by

- Slice 16 (first-sync reconcile + journal bootstrap).
- Slices 09, 11 (server sync + merge endpoints) — complete.

## Test seam

`src/sync/engine.ts` `push(event)` method — given a watcher event, a mock `SyncClientInterface`, and a mock `VaultAdapter`, verifies that the correct API method is called with the correct parameters (patch vs. whole-object vs. rename vs. delete). `src/sync/diff.ts` — round-trip tests for `createPatch / applyPatch`.
