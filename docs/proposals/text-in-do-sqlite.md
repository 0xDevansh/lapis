# Proposal: store Markdown (text) in Durable Object SQLite

**Status:** Superseded by [`sqlite-text-and-conflict-ux.md`](sqlite-text-and-conflict-ux.md) (Accepted 2026-08-22).

Keep this file only as early analysis. Do not implement from this doc.

---

## Current behavior (problem statement)

On every accepted text write:

1. DO updates manifest revision + appends `pending_ops` (often a small patch).
2. Within ~10s (or 250 ops), `flushToR2` **reconstructs full text** and `PUT`s the entire object to R2.
3. Seal later re-reads those R2 objects to commit history.

So a user who types and saves often causes **frequent full-object R2 writes** even when the logical change was a few lines. R2 is cheap, but it is the wrong grain for “chatty text head”: high request rate, rewrite amplification, and a second source of truth that can briefly disagree with the DO.

The DO already *is* the live authority. Flushing text to R2 is mostly so that:

- workers/routes can treat R2 as a simple blob store
- export/seal have a stable byte snapshot
- DO memory/SQLite is not assumed to hold entire vaults forever

---

## Proposed shape

Keep the revision / patch / merge protocol unchanged. Change **durability of latest text**:

| Content | Durable latest store |
|---|---|
| Markdown / text-like MIME | DO SQLite (chunked rows if needed) |
| Binaries / attachments | R2 (unchanged) |
| Sealed history | Artifacts / GitHub (unchanged) — still needs a byte snapshot at seal time |
| Search index | D1 FTS (unchanged; still fed on accept/flush) |

Concrete sketch:

1. Table e.g. `text_files(path_lower PRIMARY KEY, path, revision, content_type, updated_at, body)`  
   or chunked `text_chunks(path_lower, chunk_idx, bytes)` if you want a hard per-value ceiling.
2. On accept: write/replace SQLite body (or apply patch in SQL/memory and store result). Drop text from the “must materialize to R2” flush path.
3. `pending_ops` can shrink to rename/delete bookkeeping for text, or go away for text entirely if body+revision are updated in one transaction.
4. Reads (`getFileText`, plugin GET): serve from SQLite head; no R2 round-trip for Markdown.
5. Seal / zip: stream text out of SQLite into the git memory FS / zip builder; binaries still from R2.
6. Migration: one-time “load R2 text into SQLite” per vault on first open after the flag flips (same spirit as the abandoned Yjs migration, but much simpler).

Optional hybrid: keep R2 as a **cold mirror** updated only on seal (minutes), not on every flush (seconds). That preserves a blob backup without chatty writes.

---

## Benefits

1. **Stops chatty full-file R2 puts** for notes — the main pain you called out. Saves scale with keystrokes/saves, not with attachment uploads.
2. **Single latest authority for text** — DO SQLite matches how the system already thinks (`headText`). Fewer “is R2 lagging?” edge cases for Markdown.
3. **Cheaper hot path** — SQLite write inside the DO you already entered vs R2 HTTP PUT per file per flush.
4. **Patches stay natural** — apply patch → store result string; no need to rewrite an object store on every accept.
5. **Fits vault sizes Lapis already assumes** — personal Obsidian vaults are usually tens of MB of Markdown, not gigabytes of text. DO SQLite is measured in GB-class limits with caveats, which is enough for many vaults if binaries stay on R2.

---

## Losses / risks

1. **DO storage limits & cost** — All latest Markdown for a vault lives in one DO’s SQLite. A pathological vault (huge generated Markdown, checked-in datasets as `.md`) can pressure DO size. Mitigations: chunking, reject/redirect oversized text to R2, per-vault quotas.
2. **Operational coupling** — Today you can inspect/debug latest files in R2. Text-in-SQLite means debugging via DO admin/SQL or export only.
3. **Eviction / cold start** — DO SQLite is durable, but a huge text corpus makes every DO load heavier. Binaries on R2 still keep the worst weight off the DO.
4. **Seal still needs bytes** — History does not get free. You either read SQLite at seal time (fine) or keep a rare R2 mirror. You do **not** remove the need for a snapshot store.
5. **Backup story changes** — “R2 bucket = whole vault mirror” becomes “R2 = attachments + optional cold text; DO = live text.” Disaster recovery must include DO storage, not only R2.
6. **Multi-writer elsewhere stays impossible** — This does not buy collaboration; it only relocates the latest text blob. Revisions/patches remain.

---

## Implementation sketch (ordered)

1. Add SQLite text table + `getText`/`putText` helpers on `VaultCoordinator`.
2. Point `commitTextHead` / `headText` at SQLite; stop enqueueing text bodies toward R2 flush.
3. Teach seal + zip to read text from SQLite.
4. Gate with `storage_version` + one-shot R2→SQLite import.
5. Metrics: DO storage bytes, flush R2 ops (should collapse to binaries + manifest), p95 save latency.
6. Decide: cold R2 mirror on seal or not.

Leave the HTTP/plugin protocol alone so clients do not care.

---

## Recommendation

**Yes — move latest Markdown/text into DO SQLite; keep binaries on R2; keep Artifacts/GitHub for history.**

Your instinct is right for *this* architecture: the DO is already the transactional brain, and R2 full rewrites on a 10s flush are undoing that by treating notes like large opaque objects. The Yjs experiment tried to solve a different problem (CRDT merge). This change is narrower and fits the restored revision/patch model.

Do **not** put attachments in SQLite. Do **not** use DO SQLite as the sealed history store. Consider a **seal-time R2 cold mirror** if you want a bucket-shaped backup without paying R2 on every keystroke.

Suggested acceptance bar for a prototype:

- vault with ~5k Markdown files / ~50 MB text feels as fast or faster to save
- R2 write rate for text drops near zero except migration/seal mirror
- seal + zip still succeed
- one integration test: save → kill DO isolate → read same revision back from SQLite
