# Yjs CRDT Sync And DO-Resident Text

## Status

Accepted. Supersedes ADR 0002 (patch transport) and ADR 0007 (plugin patch journal as the sync model). Supersedes the Conflict Note / merge3 primary sync path from slices 11/22.

## Context

Lapis originally synced vaults with per-file monotonic revisions, unified-diff patches, and server-side three-way merge. That model fit a solo owner with a few devices, but it produces Conflict Notes under concurrent edits, cannot support multi-user collaboration cleanly, and forced text bodies through R2 as the live source of truth.

We need conflict-free multi-peer sync (web sessions, Obsidian plugins, future agents) without live cursor/awareness UI in the first multiplayer slice.

## Decision

1. **Yjs is the sync and merge layer.** Each vault has one Durable Object hosting one `Y.Doc`. Clients sync over WebSocket with `y-protocols` state-vector exchange. Text concurrency is resolved by the CRDT; Conflict Notes and `merge3` are retired for text.

2. **Stable file identities.** Content is keyed by `fileId` (UUID), not path:
   - `docs`: `Y.Map<fileId, Y.Text>` — text bodies
   - `bin`: `Y.Map<fileId, Y.Map>` — binary metadata (`r2Key`, hash, size, contentType)
   - `meta`: `Y.Map<fileId, Y.Map>` — `path`, `kind`, `contentType`, `updatedAt`, optional `deletedAt`
   - `paths`: `Y.Map<pathLower, fileId>` — secondary index updated in the same transaction as path changes

3. **Rename / move / delete:**
   - Rename updates `meta.path` and the `paths` index only; body stays on the same `fileId`.
   - Delete is soft (`deletedAt`) then hard-GC after a debounced grace window.
   - Concurrent edit after soft-delete revives the file so offline work is not lost.
   - Plugin/web treat filesystem rename/delete as meta ops, never as delete+recreate of `Y.Text`.

4. **Text lives only in DO SQLite.** Encoded Yjs updates/snapshots persist in the Durable Object’s SQLite storage and are compacted periodically. Markdown and other text-like files are not written to R2 as live content.

5. **Binaries stay in R2** with last-write-wins on metadata in the CRDT. Orphan R2 objects are GC’d on the debounce alarm.

6. **Debounced side effects remain.** After a quiet period the DO reindexes D1 FTS/backlinks/tags from the Y.Doc, seals history when configured, and runs soft-delete / R2 orphan GC.

7. **No awareness UI yet.** Clients may connect as full Yjs peers; presence/cursors are out of scope for this slice.

## Consequences

- Old REST patch/PUT/batch/seed sync protocols and plugin revision journals are replaced by Yjs peers.
- Existing vaults migrate once: load R2 text into the Y.Doc, keep binaries on R2, set `storage_version = 2`.
- DO storage size and compaction become first-class operational concerns.
- GitHub bidirectional sync must be redesigned as a Yjs peer or snapshot import/export; it is not part of the core cutover.
