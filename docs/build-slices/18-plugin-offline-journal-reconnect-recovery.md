# Slice 18 — Plugin offline journal and reconnect recovery

## What to build

When the device loses connectivity, the plugin queues all file operations in an ordered journal and replays them in one batch when connectivity returns. A corrupt journal falls back to a full manifest reconcile.

### Offline detection
- Mark `SyncEngine.isOnline = false` on the first `requestUrl` failure that returns a network error (not a 4xx/5xx — those mean the server is reachable).
- While offline, every watcher event is serialised as a `PendingOp` and appended to `journal.pendingOps`. Save journal to `data.json` after each append.
- Status bar shows `Lapis: offline (N pending)` while offline.

### PendingOp encoding
- `put`: `{ op: "put", path, contentBase64, contentType, baseRevision }`. Content base64-encoded so `data.json` stays valid JSON.
- `patch`: `{ op: "patch", path, patch, baseRevision, clientContent, baseContent? }`.
- `rename`: `{ op: "rename", oldPath, newPath }`.
- `delete`: `{ op: "delete", path }`.
- Consecutive `modify` events for the same path are coalesced: replace the pending op's content/patch with the latest value (same revision base).

### Reconnect and replay
- Detect reconnect: a successful `requestUrl` call while `isOnline === false`, or a WebSocket connection established (Slice 19).
- Set `isOnline = true`, show `Notice("Lapis: back online — replaying changes")`.
- If `journal.pendingOps.length > 0`: send `POST /api/sync/:vaultId/batch` with all pending ops in order.
- Per-op outcomes:
  - `accepted` or `merged` → update `fileRevisions` and `fileHashes`.
  - `conflict` → pull the Conflict Note; update revision.
  - `error` → log the error; do not retry that op; show a notice with the count of failed ops.
- Clear `pendingOps` from the journal after the batch response is received (regardless of individual op statuses).
- After batch replay: perform a full manifest reconcile (`pullAll`) to catch any remote changes made while offline.

### Corrupt journal fallback
- On `onload`, parse `data.json`. If `journal.version !== 1`, the journal is missing entirely, or JSON.parse throws: discard the journal, show `Notice("Lapis: journal reset — running full sync")`, and trigger a full manifest reconcile.
- The reconcile repopulates a fresh journal.

### Op coalescing
- If two pending ops for the same path are both `put` ops (rapid consecutive saves while offline), retain only the latest. The base revision in the surviving op is the base revision from the first op (preserves the server's ability to detect staleness).

## Acceptance criteria

- [x] Saving notes while offline appends `PendingOp`s to the journal and persists them to `data.json`.
- [x] After coming back online, all pending ops are replayed in order via the batch endpoint.
- [x] Notes saved offline appear in the Web Vault after reconnect.
- [x] Clean server merges during replay are accepted silently; unsafe merges create Conflict Notes.
- [x] After replay, a manifest pull catches any remote changes made while offline.
- [x] A corrupt or missing journal triggers a full reconcile on the next startup rather than crashing.
- [x] Rapid saves to the same file while offline produce a single `put` or `patch` op, not one per save.
- [x] Status bar shows `offline (N pending)` while offline and returns to `connected` after replay completes.

## Implementation notes

- Added canonical `PendingOp`, `BatchOpResult`, and `BatchSyncResponse` types to the plugin.
- Added journal append/coalesce helpers. Consecutive offline puts for the same path preserve the first base revision and keep the latest content.
- Added `LapisClient.batchSync()` and `SyncEngine.replayPending()`.
- Watcher push failures are converted into pending put/rename/delete ops and persisted to `data.json`.
- `Lapis: Sync now` replays pending ops before pulling manifest changes.
- Status bar now shows `offline (N pending)` after an operation is journaled.
- Verified with `pnpm --filter plugin run build`.

## Blocked by

- Slice 17 (online sync engine with `isOnline` flag).
- Slice 12 (server batch endpoint) — complete.

## Test seam

`src/sync/journal.ts` — save/load round-trips; op append; coalesce logic; version-mismatch reset. `src/sync/engine.ts` `replay(journal, client)` — given a fixture journal with pending ops and a mock client, verifies that `POST /batch` is called with the correct ops and that journal state is correct after each outcome type.
