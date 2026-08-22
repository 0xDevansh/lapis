# 09. Plugin Patch Sync Online

## What to build

Implement online two-way sync between a connected Local Vault and Web Vault using filesystem watcher events, text file-diff patches, whole-object binary transfers, and manifest-based change application.

## Acceptance criteria

- [x] The plugin detects local filesystem changes through a watcher.
- [x] Text-like file changes are sent as file-diff patches against known base revisions.
- [x] Binary attachment changes are uploaded as whole objects.
- [x] Rename/move operations are sent explicitly when observed, with delete/create fallback.
- [x] Accepted local changes update the Web Vault and become visible in R2 latest content.
- [x] Web Vault changes are pulled and applied to the Local Vault.
- [x] Periodic full scan fallback detects missed watcher events.

## Blocked by

- 08. Plugin Seed Local Vault

## Implementation notes

Slice 08 is skipped (Artifacts beta dependency), but the server-side sync protocol
is fully implemented here and unblocked by it.

### New files
- `worker/src/vault/patch.ts` — `applyPatch(original, patch)` and `createPatch(path, original, modified, revision)`. Minimal unified-diff applier; LCS-based diff generator for tests. Returns `null` on context mismatch.
- `worker/src/sync/routes.ts` — Device-token-authenticated sync API:
  - `GET  /api/sync/:vaultId/manifest` — pull full manifest with revision numbers
  - `GET  /api/sync/:vaultId/files/*` — pull a file (web→local direction)
  - `PUT  /api/sync/:vaultId/files/*` — push whole object; optional `X-Base-Revision` header for staleness check
  - `POST /api/sync/:vaultId/files/{path}/patch` — push unified diff; body `{patch, baseRevision}`; returns 409 on staleness, 422 on bad patch
  - `PATCH  /api/sync/:vaultId/files/*` — rename/move; body `{newPath}`
  - `DELETE /api/sync/:vaultId/files/*` — delete

### Modified files
- `worker/src/vault/manifest.ts` — `ManifestEntry.revision: number` field added (0-based, increments on every accepted write).
- `worker/src/vault/coordinator.ts` — `putFile` and `renameFile` increment revision. New sync methods: `syncPutFile` (staleness check via `X-Base-Revision`), `syncApplyPatch` (apply unified diff, strict revision match), `syncRenameFile`, `syncDeleteFile`.
- `worker/src/index.ts` — `syncRoutes` mounted at `/api/sync`.
- `web/src/api.ts` — `ManifestEntry.revision` field added.

### Protocol summary
1. Plugin fetches manifest via `GET /api/sync/:vaultId/manifest` to get current paths and revisions.
2. For each changed text file, plugin sends `POST .../patch` with a unified diff and `baseRevision` matching the last known server revision. Server returns 409 if stale (Slice 11 adds three-way merge).
3. For new files and binary changes, plugin sends `PUT` with optional `X-Base-Revision`.
4. For renames, plugin sends `PATCH` with `{newPath}`.
5. For deletes, plugin sends `DELETE`.
6. To pull Web Vault changes, plugin compares local file hashes / revisions against the manifest and fetches divergent files via `GET .../files/*`.
7. Full scan fallback: plugin periodically fetches manifest and compares against its local journal to catch any missed watcher events.
