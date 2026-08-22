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
| **VaultCoordinator** | One Cloudflare Durable Object per vault. Single writer. Owns the live manifest, pending write log, merge logic, presence, flush/seal alarms. |
| **R2** | Durable latest bytes for **binaries** (and today still for text until ADR 0010 ships), plus `_manifest.json`. |
| **D1** | Auth, devices, search/FTS, tags/backlinks, GitHub remote config. Not the live file store. |
| **Artifacts** | Default sealed Git history (append-only snapshots). |
| **GitHub** (optional) | If configured, seal prefers GitHub; inbound reconcile runs before push. |

Authority for “what is the current text of `note.md`?” is always the **Durable Object’s head** for that vault—not the browser buffer, not the plugin disk copy, and not a stale R2 object that has not been flushed yet.

---

## Roadmap (accepted, not shipped)

See [ADR 0010](adr/0010-do-sqlite-text-and-conflict-resolve.md) and the full plan [`proposals/sqlite-text-and-conflict-ux.md`](proposals/sqlite-text-and-conflict-ux.md):

1. Move all text latest content into **DO SQLite** (chunked); **no R2 for text** after migration.
2. Keep one full-text **checkpoint at `minAck`** (least common device ack) + forward diffs to head.
3. Structured conflicts + resolve API + web then plugin UX; delete Conflict Notes on resolve.

Until that lands, the rest of this document describes **current** production behavior (text still flushed to R2).

---

## Big picture

```
  Obsidian disk ◄──patch/put/notify──► Worker ──► VaultCoordinator
  Browser editor ◄──PUT + WS──────────┘                 │
                                                        │
                              live head (SQLite manifest + pending_ops
                                         + in-memory text cache)
                                                        │
                         flush (~10s / 250 ops)         │ seal (~5 min)
                                ▼                       ▼
                               R2                 Artifacts
                                                  (or GitHub)
```

Writes are accepted in the DO **immediately**. R2 is updated on a short debounce. History is sealed on a longer debounce.

---

## Revisions and the manifest

Every file has a monotonic **`revision`** integer. Clients must say which revision they edited (`baseRevision`).

The DO stores the live manifest in SQLite (`manifest_entries`). On flush it also writes `{vaultId}/_manifest.json` to R2.

Text that was accepted but not yet flushed may exist only as:

1. the last R2 blob for that path, plus
2. an ordered list of `pending_ops` (put / patch / rename / delete) in DO SQLite, plus
3. an in-memory `headContent` cache.

`headText(path)` reconstructs current text from those layers. That is why a read right after a save is correct even before R2 catches up.

---

## Write paths

### Web save

1. Open tab remembers `baseRevision` and `baseContent`.
2. Save calls `PUT /api/vaults/:id/files/*` with body `{ content }` and header `X-Base-Revision`.
3. Route calls `VaultCoordinator.syncPutFile(...)`.
4. DO `applyPut`:
   - **Same revision (or no base):** accept, bump revision, record a pending op, broadcast a `change` notification (usually with a patch so peers can apply cheaply).
   - **Stale text:** three-way merge (`merge3(base, ours, theirs)`). Clean merge → new head. Overlap → leave the original file alone and write a **Conflict Note** under `.sync-conflicts/`.
   - **Stale binary:** Conflict Note only (no silent overwrite).

If the HTTP layer still returns **409**, the web client can retry with the server’s `headRevision`. Many races never surface as 409 because the DO merges or emits a conflict note and returns success.

### Plugin online push

1. Vault watcher debounces local edits.
2. For text with a known revision: fetch server text → build a unified diff → `POST /api/sync/:vaultId/files/*/patch` with `{ patch, baseRevision }`.
3. DO `syncApplyPatch` uses the same merge / conflict-note rules.
4. Binaries (and first upload) use full `PUT` with `X-Base-Revision`.

### Batch / seed

- Offline replay uses `POST /api/sync/:vaultId/batch`.
- First connection can **seed** an empty web vault (`PUT .../seed/files/*` then `POST .../seed/complete`), which also triggers a seal.

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

Separately, the DO has its own **server WAL** (`pending_ops`) for “accepted but not yet on R2.” Do not confuse the two journals.

---

## Live notifications and presence

| Client | Endpoint | Auth |
|---|---|---|
| Web | `/api/vaults/:id/notify` | Session cookie |
| Plugin | `/api/sync/:vaultId/notify?token=` | Device bearer |

Both upgrade into the same DO WebSocket room.

- Clients send `{ type: "open", path }` / `{ type: "close_file" }`.
- Server broadcasts `change`, `presence`, and `same_file_warning`.
- Peers ignore their own `author` echoes.

Web clients try to apply an incoming patch onto a clean tab; if that fails they refetch the file. The plugin applies to disk the same way.

---

## Conflicts

Concurrent typing is **not** realtime OT/CRDT. Two writers editing the same file from different bases hit **server-side three-way merge**.

When merge cannot resolve overlapping hunks, Lapis writes a Markdown **Conflict Note** (both sides + context) under `.sync-conflicts/` and leaves the main file at the server head. That matches ADR 0002: visible, recoverable, never a silent clobber.

**Current UX:** plugin status-bar count + open folder; web toast if a notify hits `.sync-conflicts/`. `Device.resolveConflict` is still a stub.

**Target UX (ADR 0010):** structured `conflict` on write/notify; resolve API (keep-server / keep-client / use-merged); web banner + panel first, then plugin; **hard-delete** the Conflict Note on resolve.

---

## Flush and seal

| Alarm | Default | Effect |
|---|---|---|
| **Flush** | ~10s, or >250 pending ops | Materialize pending text/binaries to R2; refresh R2 manifest; update D1 FTS for touched text files |
| **Seal** | ~5 min after dirty writes | `flushToR2` first, then commit dirty paths to **GitHub** (if configured) or **Artifacts** |

Sealing is history, not the live truth. Live readers always go through the DO (which may read R2 underneath).

Zip export and snapshot listing read sealed history / vault content through the Worker → DO.

---

## Code map

| Concern | Where |
|---|---|
| DO writes, flush, seal, WS | `worker/src/vault/coordinator.ts` |
| Diff / patch / merge3 | `worker/src/vault/patch.ts` |
| Conflict notes | `worker/src/vault/conflict.ts` |
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
5. R2 can lag the DO head by seconds; that is intentional.
6. Secrets (Artifacts tokens, GitHub PATs) stay server-side.

For *why* these choices exist, see [`adr/`](adr/), especially 0001–0004 and 0007.
