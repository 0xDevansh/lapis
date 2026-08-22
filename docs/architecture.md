# Sync architecture

This is how Lapis keeps a **Web Vault**, one or more **Obsidian Local Vaults**, and optional **Git history** coherent today.

Lapis does **not** use CRDTs or Yjs. Sync is **per-file revisions**, **unified-diff patches** for text, **whole-object puts** for binaries, and a **Durable Object** that serializes every write for a vault.

---

## The cast

| Piece | What it does |
|---|---|
| **Web app** (`web/`) | Browser editor. Saves with an explicit `PUT` and a `baseRevision`. Listens on a notify WebSocket for remote changes. |
| **Obsidian plugin** (`plugin/`) | Watches the local vault, pushes patches/puts, keeps an offline **journal**, applies remote changes to disk. |
| **Worker** (`worker/`) | HTTP API: session auth for the web, device-token auth for the plugin. |
| **VaultCoordinator** | One Cloudflare Durable Object per vault. Single writer. Owns the live manifest, chunked text, retained merge history, acknowledgements, conflicts, presence, and flush/seal alarms. |
| **R2** | Immutable content-addressed **binary blobs** plus `_manifest.json`. Text bodies never use R2 after storage migration. |
| **D1** | Auth, devices, search/FTS, tags/backlinks, GitHub remote config. Not the live file store. |
| **Artifacts** | Default sealed Git history (append-only snapshots). |
| **GitHub** (optional) | If configured, seal prefers GitHub; inbound reconcile runs before push. |

Authority for “what is the current text of `note.md`?” is always the **Durable Object’s head** for that vault—not the browser buffer, not the plugin disk copy, and not a stale R2 object that has not been flushed yet.

---

## Storage decisions

[ADR 0010](adr/0010-do-sqlite-text-and-conflict-resolve.md) defines text storage, chunking, and retained merge history. [ADR 0011](adr/0011-structured-conflict-resolution.md) defines conflict creation and resolution. [ADR 0012](adr/0012-lapis-managed-lfs-pointer-sealing.md) defines binary blob storage and Git LFS pointer sealing. The detailed text/conflict implementation plan is retained in [`proposals/sqlite-text-and-conflict-ux.md`](proposals/sqlite-text-and-conflict-ux.md).

---

## Big picture

```
  Obsidian disk ◄──patch/put/notify──► Worker ──► VaultCoordinator
  Browser editor ◄──PUT + WS──────────┘                 │
                                                        │
                              DO SQLite
                       manifest + chunked text heads
                    checkpoint/diffs + acks + conflicts
                            │                    │
               binary + manifest flush          │ seal (~5 min)
                            ▼                    ▼
                           R2              Artifacts/GitHub
```

Writes are accepted in the DO **immediately**. Binary bytes and the optional manifest mirror are flushed to R2; text bodies stay in SQLite. History is sealed on a longer debounce.

---

## Revisions and the manifest

Every file has a monotonic **`revision`** integer. Clients must say which revision they edited (`baseRevision`). The DO stores the live manifest in `manifest_entries`.

For `isTextContentType` entries, the materialized head is stored in `text_files` plus UTF-8-safe `text_chunks`. A new or migrated text file starts with a full checkpoint. Each later commit stores the canonical forward diff from the previous server head in `text_updates` (with chunk rows for oversized patches).

For each path, retained merge history is:

1. one full-text checkpoint at `minAck`, the least revision acknowledged by retained clients;
2. contiguous forward diffs from `minAck` to head; and
3. the materialized chunked head for cheap reads.

Plugin devices stop retaining history after 30 days without activity. Browser acknowledgements expire after 24 hours. When `minAck` advances, the DO reconstructs that revision, replaces the checkpoint, and deletes obsolete diffs. A client older than the checkpoint takes the conflict path; the server never substitutes the current head as a fake merge base.

Text bodies are not written to or read from R2 once `storage_version` is 2. Migration materializes legacy R2 text into SQLite, verifies it, writes the initial checkpoint, deletes the legacy object, and then marks the vault migrated.

---

## Write paths

### Web save

1. Open tab remembers `baseRevision` and `baseContent`.
2. Save calls `PUT /api/vaults/:id/files/*` with body `{ content }` and header `X-Base-Revision`.
3. Route calls `VaultCoordinator.syncPutFile(...)`.
4. DO `applyPut`:
   - **Same revision (or a new path):** accept, bump revision, persist the new head and canonical diff, and broadcast a `change` notification (usually with a patch so peers can apply cheaply).
   - **Stale text:** three-way merge (`merge3(base, ours, theirs)`). Clean merge → new head. Overlap → leave the original file alone and write a **Conflict Note** under `.sync-conflicts/`.
   - **Stale binary:** Conflict Note only (no silent overwrite).

After applying a returned server revision, the browser acknowledges it. Writes that cannot reconstruct their base return a structured conflict rather than silently rebasing against head.

### Plugin online push

1. Vault watcher debounces local edits.
2. The plugin sends the local bytes with the journal's true `baseRevision`.
3. The DO uses the same text merge / conflict-note rules as web saves; binaries remain whole-object writes.
4. The plugin applies any merged server result, updates its journal, then acknowledges the applied revision.

### Batch / seed

- Offline replay uses `POST /api/sync/:vaultId/batch`.
- First connection can **seed** an empty web vault (`PUT .../seed/files/*` then `POST .../seed/complete`), which also triggers a seal. Seed writes use the normal coordinator path: text goes to DO SQLite and binaries go to R2.
- Upload MIME is normalized from known path extensions on the Worker, so generic client headers cannot route JSON, Canvas, CSS, or other managed text into R2. The plugin uses the same extension policy.
- Binary uploads avoid the 32 MiB Durable Object RPC serialization limit: uploads use a short-lived R2 staging key, the coordinator records only SHA-256 blob metadata, and downloads are streamed through the coordinator's internal `fetch` endpoint. The final authority remains SQLite for text and R2 for binaries.
- The plugin persists an `initialSeedPending` journal marker before uploading. If the initial upload is interrupted, the next normal or forced sync finishes reconciliation and calls `seed/complete` before clearing the marker.
- Full reconcile uses the journal revision as the merge base. With no prior cursor, `baseRevision = -1` means “no shared history” and uses an empty merge base; it never claims local bytes were based on the current server head. Any clean merged result is fetched back before the journal hash is updated.
- Opted-in Vault Internals use the same MIME-based storage split but remain hidden from web manifests and devices that did not opt in.

---

## Offline: the plugin journal

The plugin stores a small JSON journal in Obsidian plugin data (not on the server):

- last known `fileRevisions` / content hashes
- `pendingOps` (put / patch / rename / delete) queued while offline

On reconnect, `syncNow` roughly:

1. `replayPending()` via batch
2. push any remaining local changes
3. pull remote changes

The notify WebSocket reconnecting alone does **not** replay the journal; an explicit sync pass does.

Separately, the DO has a `pending_ops` queue used by binary/manifest flush and text indexing. It is not the text source of truth and is unrelated to the plugin journal.

---

## Live notifications and presence

| Client | Endpoint | Auth |
|---|---|---|
| Web | `/api/vaults/:id/notify` | Session cookie |
| Plugin | `/api/sync/:vaultId/notify?token=` | Device bearer |

Both upgrade into the same DO WebSocket room.

- Clients send `{ type: "open", path }` / `{ type: "close_file" }`.
- Server broadcasts `change`, `conflict`, `conflict_resolved`, `presence`, and `same_file_warning`.
- Peers ignore their own `author` echoes.

Web clients try to apply an incoming patch onto a clean tab; if that fails they refetch the file. The plugin applies to disk the same way.

---

## Conflicts

Concurrent typing is **not** realtime OT/CRDT. Two writers editing the same file from different bases hit **server-side three-way merge**.

When merge cannot resolve overlapping hunks—or the requested ancestor has been garbage-collected—Lapis writes a Markdown **Conflict Note** under `.sync-conflicts/`, stores structured server/client/base content in chunked SQLite rows, and leaves the main file at the server head. Binary conflicts follow the same record flow without text versions.

The write response and `conflict` notification include the note path, original path, revisions, binary flag, and available versions. Open conflicts survive reloads and reconnects and can be listed through both web and device-authenticated APIs.

Web and plugin clients expose persistent conflict counts and a three-version review panel. Resolution is explicit:

- `keep-server` preserves the current head;
- `keep-client` commits the captured client version; or
- `use-merged` commits edited text.

Success updates the client revision/journal, broadcasts `conflict_resolved`, and hard-deletes the Conflict Note locally and on the server. If note deletion fails after the conflict is marked resolved, the alarm retries it.

---

## Flush and seal

| Alarm | Default | Effect |
|---|---|---|
| **Flush** | ~10s, or >250 pending ops | Flush binary bytes, refresh the R2 manifest, clear applied pending rows, and update D1 FTS for touched text files; text bodies remain in SQLite |
| **Seal** | ~5 min after dirty writes | `flushToR2` first, then commit dirty paths to **GitHub** (if configured) or **Artifacts** |

Sealing is history, not the live truth. Live readers always go through the DO, which reads text from SQLite and binaries from R2.

Git sealing writes text as normal Git blobs and binaries as standard Git LFS pointer files whose `oid sha256:<hash>` references the same immutable R2 blob used by live sync. The sealer constructs commits from Git tree object IDs and dirty deltas, so unchanged files are preserved without checking out binary worktrees.

Lapis does not yet expose an external Git LFS Batch API. External Git clients may see pointer files in sealed Git history; normal `git lfs clone`, `pull`, and `push` will require future authenticated batch/transfer endpoints, repository `.gitattributes` / `.lfsconfig`, and GitHub OAuth through Better Auth. If GitHub OAuth is not configured, external LFS client support should remain unavailable.

Zip export and snapshot listing read sealed history / vault content through the Worker → DO.

---

## Storage health metrics

Each vault alarm emits a structured `lapis.storage_metrics` log event through Workers observability. It includes:

- `doStorageBytes`: current SQLite database size;
- `r2TextPuts`: cumulative instrumented text-body puts to R2 (must remain `0` for migrated vaults);
- `textFileCount`, `textUpdateCount`, and `maxChainLength`;
- `maxAckLagRevisions`: largest head-to-checkpoint revision gap;
- open/resolved conflict counts and `conflictResolveRate`.

The same snapshot is available from the coordinator's `getStorageMetrics()` RPC for tests and diagnostics. Alert on any post-migration `r2TextPuts`, sustained database growth, deep chains/ack lag, or conflict resolution regressions.

---

## Code map

| Concern | Where |
|---|---|
| DO writes, flush, seal, WS | `worker/src/vault/coordinator.ts` |
| Text chunks, checkpoints, diffs, acks | `worker/src/vault/text-store.ts` |
| LFS pointer formatting | `worker/src/git/lfs-pointer.ts` |
| Diff / patch / merge3 | `worker/src/vault/patch.ts` |
| Conflict note format | `worker/src/vault/conflict.ts` |
| Web vault HTTP | `worker/src/vault/routes.ts` |
| Plugin sync HTTP | `worker/src/sync/routes.ts` |
| Notify upgrade | `worker/src/notify/routes.ts` |
| Artifacts seal | `worker/src/artifacts/sealer.ts` |
| GitHub remote | `worker/src/git/*` |
| Plugin engine + journal | `plugin/src/sync/engine.ts`, `journal.ts` |
| Web save + notify | `web/src/api.ts`, `hooks/useVaultNotify.ts`, `pages/VaultWorkspace.tsx` |

---

## Invariants worth protecting

1. **One DO per vault** is the only place that bumps revisions.
2. Clients never write R2 or D1 FTS directly.
3. Text sync is patch-oriented; binaries are whole-object.
4. Unresolvable overlap → Conflict Note, not last-write-wins on the main path.
5. Revision acknowledgement happens only after a client successfully applies the matching server content.
6. R2 contains no text body after storage migration; binary manifest entries point at immutable SHA-256 blob objects.
7. Conflict resolution is idempotence-protected by the open conflict row and hard-deletes its note.
8. Secrets (Artifacts tokens, GitHub PATs) stay server-side.

For *why* these choices exist, see [`adr/`](adr/), especially 0001–0004, 0007, and 0010–0012.
