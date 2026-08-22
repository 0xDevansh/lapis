# Plan: DO SQLite text storage + first-class conflict UX

**Status:** Accepted for implementation (2026-08-22) — not yet shipped  
**Depends on:** current revision/patch sync ([`../architecture.md`](../architecture.md))  
**Supersedes:** [`text-in-do-sqlite.md`](text-in-do-sqlite.md)  

Two linked upgrades:

1. **Durable latest text in Durable Object SQLite** — **no R2 for text at all** (binaries only on R2).
2. **First-class conflict UX** on web then plugin, finishing `Device.resolveConflict`.

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | **All** `isTextContentType` files live in DO SQLite (md, plain, json, css, …). |
| D2 | **No R2 for text.** Latest text, seal input, zip export, and migration target are SQLite-only. R2 is binaries (+ vault `_manifest.json` if we still mirror it). |
| D3 | **Chunk on write/read** — no spill-to-R2 for oversized text. Chunking is the sizing strategy (see below). |
| D4 | Ship **API + web UX first**, then plugin. |
| D5 | Write `.sync-conflicts/*.md` while open; **hard-delete** the note when resolved (no archive). |
| D6 | **Wire real `Device.resolveConflict`** on web + plugin. |
| D7 | **One full-text checkpoint at `minAck` (LCR of device acks)**; forward diffs only from that revision to head; advance checkpoint when minAck rises (see below). |

---

## Goals

### Storage

- Zero R2 `PUT`/`GET` for text file bodies after migration.
- Chunked SQLite blobs for arbitrary text size (within DO storage budget).
- Seal / zip / GitHub read text from SQLite.
- One-shot R2→SQLite migration; then GC orphaned R2 text keys.

### History for merges (D7)

- **Checkpoint = full text at least-common ack (`minAck`)** across retained devices.
- Diffs only for revisions above that watermark up to head.
- When minAck advances, rewrite checkpoint to that revision and drop older diffs (TTL for abandoned devices).

### Conflicts

- Structured `conflict` on write + notify.
- Resolve API: keep-server / keep-client / use-merged → **delete** conflict note.
- Web banner + panel first; plugin view second.
- `Device.resolveConflict` is real.

### Non-goals

- No Yjs/CRDT, no attachment-in-SQLite, no replacing Artifacts/GitHub, no members/MCP work in this plan.

---

## Checkpoint + diffs (detailed design)

This is how we retain **ancestors for three-way merge** without storing a full copy of every revision.

### What “revision C” was

**C** was only a placeholder name for “checkpoint revision” in an earlier draft — it did **not** mean anything special. That was confusing.

### Your rule (locked)

The **only** full-text historical snapshot is the file body at the **least common acked revision**:

\[
L = \minAck(\text{path}) = \min\{\,\text{acked revision of }d\text{ for this path} \mid d \in \text{retained devices}\,\}
\]

| Symbol | Meaning |
|---|---|
| `H` | Head — latest accepted revision |
| `L` / `minAck` | Least common ack across retained connected devices |
| Checkpoint | **Exactly one** full text body, at revision **`L`** |
| Diffs | Forward unified diffs covering **`L → H` only** |

```text
  [full text @ L = minAck]      ← sole checkpoint
       │
       ├─ diff L → L+1
       ├─ diff …
       └─ diff H-1 → H

  [materialized head @ H]       ← fast GET/save/seal (same bytes as fold(L, diffs))
```

When every device catches up and `minAck` rises from `L` to `L'` (`L' ≤ H`):

1. Reconstruct text at `L'` (old checkpoint + diffs through `L'`).
2. **Replace** the checkpoint with that full text @ `L'`.
3. **Delete** all diffs with `to_rev ≤ L'`.
4. Chain is now only `L' … H`.

If `L = H` (everyone acked head): **zero diffs** — checkpoint and head are the same content.

We do **not** invent extra checkpoints every N edits at head. Compaction-by-count is dropped; **ack advance *is* GC**.

### Mental model

| Layer | Role |
|---|---|
| **Materialized head** | Current file; hot path |
| **Checkpoint @ `L`** | Full text at LCR / minAck — base for reconstruct |
| **Updates** | Diffs from `L` toward `H` — only what someone has not acked yet |
| **Acks** | Move `L`; rewrite checkpoint; drop obsolete diffs |

Clients never see checkpoints. They still send `baseRevision` + put/patch. The DO uses this only for `resolveBaseText` / merge3.

### Invariants

1. Head chunks match accepted content at `H`.
2. **One checkpoint per path**, with `checkpoint.revision == minAck` after each ack pass (bootstrap exceptions below).
3. Updates are contiguous: for every `r ∈ (L, H]`, one row `from_rev=r-1, to_rev=r`.
4. `reconstruct(R)` for `L ≤ R ≤ H` is exact; `R < L` → null (ancestor GC’d).
5. Diffs are unified diffs via existing `createPatch` / `applyPatch`.

### Commit lifecycle

Head at `H`, checkpoint at `L`, new text `T_new`:

```
patch = createPatch(oldHead, T_new)
H' = H + 1
write head chunks @ H'
append update H → H'
# checkpoint stays @ L until acks move
```

First create: head @ 1 and checkpoint @ 1.

### Reconstruct

```ts
function reconstruct(path, targetRev): string | null {
  if (targetRev < checkpoint.revision) return null
  if (targetRev === head.revision) return readHead(path)
  let text = readCheckpoint(path)  // full body @ L
  if (targetRev === checkpoint.revision) return text
  for (u of updates where L < to_rev <= targetRev order by to_rev) {
    text = applyPatch(text, u.patch)
    if (text === null) return null
  }
  return text
}
```

### Advancing checkpoint when acks move (your rule)

```
onAcksUpdated(path):
  L' = minAck(path)          // least common acked revision
  L  = checkpoint.revision
  H  = head.revision
  clamp L' into (L, H]
  body = reconstruct(path, L')   // must succeed
  replace checkpoint with body @ L'
  delete updates where to_rev <= L'
```

Example: Plugin A acked 12, Plugin B acked 9 → `L = 9`, full text stored at rev 9, diffs 9→…→H.  
When B acks 12 and H is 12 → checkpoint becomes head, diffs cleared.

### Bootstrap

| Situation | Policy |
|---|---|
| New file, no acks yet | Checkpoint @ head; treat minAck as head |
| Retained devices exist but none acked this path | Prefer minAck = head until ≥1 ack row exists, then true min |
| All devices revoked / excluded by TTL | Checkpoint @ head; clear diffs |

### Escape hatches (so L is not pinned forever)

- Web session acks: TTL **24h**
- Device not seen **30d** or revoked: excluded from minAck
- Lagging device intentionally keeps `L` low so offline reconnect can still merge — that growth is correct

### Failure modes

| Case | Behavior |
|---|---|
| Client `baseRevision < L` | Cannot reconstruct → Conflict Note |
| Corrupt / gapped diff chain | reconstruct null → Conflict Note + metric; do not advance checkpoint |
| False ack | May raise L too early → later Conflict Note; ack only after local rev/hash match |

### Storage updates vs wire patches

Canonical `text_updates` row is always `createPatch(prevHead, committedHead)`, not the client wire patch (merge may change the result).

### Modules

```
text-store.ts  writeHead, readHead, reconstruct, setCheckpointAt(L)
acks.ts        setAcks, minAck, onAcksUpdated → setCheckpointAt
commitTextHead writeHead + appendUpdate
ack routes / alarm  onAcksUpdated
```

No `compact()` that checkpoints head on a timer.

### Tests

1. One device lagging → checkpoint stays at its ack; reconstruct that base works.
2. All ack head → one checkpoint, zero updates.
3. minAck advances mid-chain → new checkpoint matches golden text; old diffs gone.
4. Merge with baseRevision < minAck → conflict path.
5. Multi-chunk checkpoint round-trip.

### Not doing

- Multiple checkpoints / “compact every 32 edits”
- Reverse diffs
- Global vault op-log
- Using this chain as user-visible history

---

## Chunking (storage & retrieval)


Cloudflare DO SQLite values should stay modest (practical target **≤ 1 MiB per BLOB cell**; use 512 KiB chunks for margin).

### Constants

```ts
const TEXT_CHUNK_SIZE = 512 * 1024; // bytes, UTF-8
```

Chunking is on **UTF-8 bytes**, not characters. Split only at byte boundaries that are valid UTF-8 (never tear a codepoint: back up to char start if needed).

### Write path (`writeTextFile`)

```
input: path, revision, contentType, text: string
bytes = TextEncoder.encode(text)
DELETE FROM text_chunks WHERE path_lower = ?
for i in 0..ceil(bytes.length / TEXT_CHUNK_SIZE):
  INSERT chunk_idx=i, bytes=slice
UPSERT text_files(path_lower, path, revision, content_type, updated_at, size, chunk_count)
```

Same helper used for:

- Materialized **head** (`text_files` + `text_chunks`)
- **Checkpoints** (`text_checkpoints` + `text_checkpoint_chunks`, or reuse chunks table with `kind`)

### Read path (`readTextFile`)

```
meta = SELECT size, chunk_count, revision FROM text_files WHERE path_lower = ?
rows = SELECT bytes FROM text_chunks WHERE path_lower = ? ORDER BY chunk_idx
assert contiguous 0..chunk_count-1
return TextDecoder.decode(concat(rows))
```

Streaming variant for seal/zip: iterate chunks and write to the git/zip sink without building one giant string when possible (encoder path may still need string for markdown; binaries are R2 streams).

### Patches in the update chain

Unified diffs are usually small → store as a single `TEXT`/`BLOB` column on `text_updates`.  
If a rare patch exceeds `TEXT_CHUNK_SIZE`, store it chunked in `text_update_chunks` keyed by `(path_lower, to_rev, chunk_idx)`.

### Rename / delete

- Rename: update `path`/`path_lower` on all text tables for that file in one transaction (or copy-forward + delete old keys).
- Delete: delete head chunks, checkpoints, updates for that path.

### Why not spill to R2

You chose no R2 for text. Chunking removes the per-cell limit issue. The remaining limit is **total DO SQLite size** for the vault — monitor and alert; do not silently put text back on R2.

---

## Ack-based ancestor GC

### What “acked” means

A device has **acked revision R for path P** when it has successfully applied server head ≥ R into its local journal/disk (plugin) or tab state (web) and told the coordinator.

### Protocol

1. After applying a remote `change` (or completing pull for `P`), client sends:

   ```http
   POST /api/sync/:vaultId/acks          # device
   POST /api/vaults/:id/acks             # web session (optional, short-lived)
   { "acks": [ { "path": "note.md", "revision": 12 } ] }
   ```

2. DO stores:

   ```sql
   CREATE TABLE device_acks (
     device_key TEXT NOT NULL,     -- "plugin:<id>" | "web:<session>"
     path_lower TEXT NOT NULL,
     revision   INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (device_key, path_lower)
   );
   ```

3. **`minAck(path)`** = minimum `revision` among **retained** device keys for that path.
   - If a device has **no row** yet: treat as `0` only until first sync completes; after first full pull, ack all paths (or ack vault `head` watermark).
   - Simpler v1: also maintain **vault-level** ack `devices.sync_cursor` = opaque JSON `{ "v": 1, "files": { "note.md": 12 } }` in D1, mirrored into DO on sync — but per-path in DO is enough for GC.

### Who counts for minAck

| Device kind | Counts? | Notes |
|---|---|---|
| Plugin (not revoked) | Yes | Primary pin |
| Agent | Yes if bidirectional | Same |
| Web session | Soft | TTL **24h** after last presence; do not pin forever |
| Revoked / not seen **30d** | No | Drop from minAck set (escape hatch) |

Without the TTL escape, a lost laptop pins history forever.

### GC algorithm (on alarm or after ack)

Same as **advancing the checkpoint** in the design above — there is no separate multi-checkpoint GC:

```
m = minAck(path)   # if no retained acks yet, m = head
if m > checkpoint.revision:
  body = reconstruct(path, m)
  replace sole checkpoint with body @ m
  delete updates where to_rev <= m
```

### Interaction with offline journal

Offline plugin still has `baseRevision = old`. Until it reconnects and acks, `minAck` stays low → chain retained → `resolveBaseText(old)` works. After batch/merge/conflict resolve and pull, plugin acks new head → GC can advance.

---

## Data model (DO SQLite)

```sql
-- Materialized head (fast GET/save)
CREATE TABLE text_files (
  path_lower   TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL
);
CREATE TABLE text_chunks (
  path_lower TEXT NOT NULL,
  chunk_idx  INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (path_lower, chunk_idx)
);

-- Merge history: exactly one checkpoint per path (= minAck), plus diffs to head
CREATE TABLE text_checkpoints (
  path_lower   TEXT PRIMARY KEY,   -- one row per file
  revision     INTEGER NOT NULL,   -- == minAck when settled
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE text_checkpoint_chunks (
  path_lower TEXT NOT NULL,
  chunk_idx  INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (path_lower, chunk_idx)
);
CREATE TABLE text_updates (
  path_lower TEXT NOT NULL,
  from_rev   INTEGER NOT NULL,
  to_rev     INTEGER NOT NULL,
  patch      TEXT NOT NULL,      -- unified diff; chunk if huge (rare)
  PRIMARY KEY (path_lower, to_rev)
);

CREATE TABLE device_acks (
  device_key TEXT NOT NULL,
  path_lower TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_key, path_lower)
);

-- manifest_entries unchanged; for text, r2_revision unused / 0
```

Binaries: unchanged R2 + existing binary `pending_ops` flush.

---

## Conflict protocol (locked)

On unsafe merge:

1. Leave `path` at server head.
2. Write Conflict Note under `.sync-conflicts/` (UX backup + Obsidian).
3. Return + broadcast structured `conflict`.

Resolve:

```http
POST /api/vaults/:id/conflicts/resolve
POST /api/sync/:vaultId/conflicts/resolve
{
  "path": "note.md",
  "conflictNote": ".sync-conflicts/…",
  "action": "keep-server" | "keep-client" | "use-merged",
  "content": "…"   // required unless keep-server
}
```

Server: apply choice at current head revision → **DELETE** conflict note from vault → broadcast `change` + `conflict_resolved`.  
No archive folder.

---

## Target flow

```
accept text  → SQLite head chunks + append text_updates
accept binary→ R2
stale text   → resolveBaseText (checkpoint @ minAck + diffs) → merge3
             → commit OR conflict note + structured conflict
ack          → raise minAck → rewrite checkpoint @ minAck, drop older diffs
seal/zip     → read text chunks from SQLite; binaries from R2
resolve UX   → Device.resolveConflict → delete note
```

---

## Slice plan

### S0 — Contracts (½–1 day)

- Lock MIME = `isTextContentType`.
- Types: chunk helpers API, `ConflictPayload`, resolve/ack request bodies.
- `storage_version`: `1` = R2 text, `2` = SQLite text only.

### S1 — Chunked SQLite head (2–4 days)

**Blocked by:** S0  

- `writeTextFile` / `readTextFile` / `deleteTextFile` with chunking.
- `headText` / `commitTextHead` use SQLite when version ≥ 2.
- **No** text in R2 flush path; flush alarm = binaries + optional manifest JSON only.
- Seal + zip read text via chunked reads.
- Tests: multi-chunk round-trip; UTF-8 boundary; rename/delete; DO restart persistence.

**Acceptance:** Save markdown; no R2 object for that path; seal still includes file.

### S2 — Migration + R2 text GC (1–2 days)

**Blocked by:** S1  

- On DO open: if version &lt; 2, for each text manifest entry `GET` R2 → `writeTextFile`, set version 2.
- S2.1: delete R2 keys for migrated text paths (after soak / flag). Until then orphans OK for rollback.

**Acceptance:** Old vault serves text from SQLite; binaries unchanged.

### S3 — Checkpoint @ minAck + diff chain + acks (2–4 days)

**Blocked by:** S1  

- On commit: append `text_updates` (prev head → new head); refresh materialized head; **no** timer-based head checkpoints.
- Ack routes (device required; web optional with TTL).
- On ack: recompute `minAck`; if raised, replace checkpoint with full text at that rev; delete diffs `to_rev ≤ minAck`.
- Plugin/web: send acks after successful apply/pull.
- `resolveBaseText` = checkpoint @ minAck + fold diffs; if `baseRevision < minAck` → conflict path.
- Safety: devices not seen 30d excluded; web acks expire 24h.
- Fix online `pushPut` to use `createPatch(base, client)` or full put with true `baseRevision`.

**Acceptance:** Offline plugin at rev 3 vs server at rev 10 still merges while minAck≤3; after everyone acks head, one checkpoint and zero updates; slowest device bounds chain length.

### S4 — Structured conflicts API (1–2 days)

**Blocked by:** S0 (parallel S1)  

- Enrich write result + `conflict` notify.
- Resolve routes; **hard-delete** note on success.
- Clients parse `conflict` object.

### S5 — Device.resolveConflict (1 day)

**Blocked by:** S4  

- Implement web + plugin against resolve API; remove stubs.
- Shared client helper OK if full `sendEdit` migration waits.

### S6 — Web conflict UX (2–3 days)

**Blocked by:** S4–S5 · **D4**  

- Persistent banner + resolve panel (server / yours / base).
- Keep server · Keep yours · Manual merge → resolve → note gone.
- Command palette list.

### S7 — Plugin conflict UX (2–3 days)

**Blocked by:** S4–S5, ideally after S6 patterns  

- Notice + badge; modal/view with same three actions.
- Journal update; delete local conflict note file after resolve.

### S8 — Hardening & docs (1–2 days)

- Metrics: DO bytes, R2 text puts (=0), chain length, ack lag, conflict resolve rate.
- Update `architecture.md`; ADR 0010 (SQLite text + chunking + checkpoint/diff); ADR 0011 (conflict resolve).
- Mark this proposal Accepted.

---

## Sequencing

```text
S0
├── S1 head+chunks ──► S2 migrate ──► S3 checkpoint/diff/acks
└── S4 conflict API ──► S5 Device ──► S6 web UX ──► S7 plugin UX
                                              └──► S8
```

---

## Edge cases

| Case | Handling |
|---|---|
| Huge markdown | Many chunks; no R2 spill; monitor DO size |
| UTF-8 tear at chunk boundary | Split only at codepoint boundary |
| Long offline, no ack | Chain retained until TTL kicks device out; then merge may degrade — Conflict Note |
| Lost device | 30d exclusion from minAck |
| Patch apply fails in chain | Treat as corruption: rebuild head from last known good checkpoint + panic metric; never silent |
| Conflict resolve | Delete note file; if delete fails, still mark resolved in DO table and retry delete |
| Binary | R2 only; conflict keep-server/keep-client upload |
| Manifest on R2 | Optional; not file bytes |

---

## Tests (minimum)

- Chunk write/read across 1 byte, `CHUNK±1`, multi-MiB.
- Checkpoint + 50 updates → `resolveBaseText` at each step matches.
- Ack advances → GC removes expected rows only.
- Migration checksum R2 vs SQLite.
- Conflict resolve deletes note; second resolve 404s.
- Web + plugin manual conflict E2E.

---

## Risks

| Risk | Mitigation |
|---|---|
| DO storage growth | Ack-driven checkpoint advance; alert on bytes / chain length behind minAck |
| Ack protocol forgotten by client | Server metrics on ack lag; warn in plugin diagnostics |
| Web sessions pinning history | 24h TTL |
| Reconstruct CPU on deep chains | Compact threshold; materialized head |
| Seal latency | Chunk iteration; seal already debounced |

---

## Effort (revised)

| Slice | Days |
|---|---|
| S0 | 0.5–1 |
| S1 | 2–4 |
| S2 | 1–2 |
| S3 | 2–4 (acks + chain; larger than before) |
| S4 | 1–2 |
| S5 | 1 |
| S6 | 2–3 |
| S7 | 2–3 |
| S8 | 1–2 |
| **Total** | **~13–22** eng days |

---

## Success metrics

1. R2 ops for text body keys = 0 after migration GC.
2. Save p95 ≤ baseline.
3. Ancestor reconstruct success rate high while devices healthy; Conflict Notes only on true overlap or abandoned-device TTL.
4. ≥80% conflicts resolved via UI; notes deleted after resolve.
5. Steady-state `text_updates` row count bounded under normal ack behavior.
