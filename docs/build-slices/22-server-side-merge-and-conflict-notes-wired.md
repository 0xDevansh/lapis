# 22. Server-Side Three-Way Merge And Conflict Notes (Wired)

## What to build

Actually invoke the already-implemented `merge3()` and Conflict Note renderer from the
coordinator when a text patch/PUT arrives stale, so concurrent edits merge automatically
when safe and produce a visible `.sync-conflicts/` note when not. This completes the
long-dormant Slice 11.

## Why

`worker/src/vault/patch.ts` `merge3()` and `worker/src/vault/conflict.ts`
(`conflictNotePath`, `renderConflictNote`) are fully implemented but **never called** — a
stale write today is either rejected with 409 (server) or rebased client-side (plugin),
which can still overwrite. Wiring these in is required correctness on its own and is a hard
dependency for GitHub sync (Slice 26 reuses the same merge engine).

## Acceptance criteria

- [ ] When `syncApplyPatch` / `applyPut` (text) receives a `baseRevision` older than the
      current server revision, the server attempts `merge3(base, ours, theirs)` where
      `base` = content at the client's base revision, `ours` = current server head,
      `theirs` = the client's submitted content.
- [ ] A clean merge (`hasConflicts === false`) is committed as a normal new revision and
      broadcast like any other change; the client receives the merged head.
- [ ] An unsafe merge (`hasConflicts === true`) does **not** overwrite the original file.
      Instead a Conflict Note is created at `conflictNotePath(...)` under `.sync-conflicts/`
      with full server/client/base context, and both the note and the untouched original
      are broadcast.
- [ ] Binary stale writes create a Conflict Note (`isBinary: true`) and keep the server
      version at the original path.
- [ ] Deleting a Conflict Note is ordinary sync behavior (no special handling needed).
- [ ] `base` retrieval works even after R2 flush: if the exact base revision content is not
      recoverable, fall back to treating the write as a two-way conflict (base = server head)
      → forces a Conflict Note rather than a bad merge.
- [ ] Slice 11 acceptance checkboxes are all satisfied; update `11-*.md` to check them.

## Blocked by

- 09. Plugin Patch Sync Online
- 21. Canonical Device Identity And Plugin Sync Concurrency

## Implementation notes

### Recovering `base`
The merge needs the common-ancestor text. Options, in priority order:
1. If the client's `baseRevision` equals the current `r2_revision` and no pending ops have
   folded past it, `materializeText` against R2 gives the base directly.
2. Otherwise, reconstruct by reverse-applying pending patches newer than `baseRevision`
   from `pending_ops` (they are stored in order with `base_revision`/`new_revision`).
3. If neither is possible, set `base = ours` (server head). `merge3(ours, ours, theirs)`
   degenerates to "theirs replaces changed regions" — but any real divergence becomes a
   conflict, which is the safe outcome. Document this fallback explicitly.

### Coordinator changes (`worker/src/vault/coordinator.ts`)
- In `syncApplyPatch` and the text branch of `applyPut`, replace the current
  `assertBaseRevision` hard-reject with:
  1. If `baseRevision === entry.revision`: fast path (today's behavior).
  2. Else: resolve `base`, compute `ours`/`theirs`, call `merge3`.
     - clean → write merged as new revision (reuse existing pending-op + broadcast path).
     - conflict → call new `writeConflictNote(...)`, keep original, broadcast both.
- Add `private async writeConflictNote(vaultId, ctx: ConflictContext)` that writes the note
  as a normal text file via the existing put path (so it flushes to R2, indexes, seals, and
  broadcasts like any file). Import from `./conflict`.
- Keep the HTTP 409 contract available for callers that opt out of merge (add an internal
  `mergeMode: "merge" | "reject"` param defaulting to `"merge"`); GitHub sync (Slice 26)
  and tests may want `"reject"`.

### Route changes
- `worker/src/sync/routes.ts` and `worker/src/vault/routes.ts`: a merged result returns 200
  with the new entry (unchanged shape). A conflict-note outcome also returns 200 but with a
  field indicating a conflict was recorded, e.g. `{ ...entry, conflictNote: "<path>" }`, so
  clients can surface it. Preserve the 409 path for `mergeMode: "reject"`.

### Client surfacing
- `plugin/src/ui/status.ts` already counts `.sync-conflicts/` — no change needed; the notes
  now actually appear. Verify the "Open conflicts folder" command reveals them.
- `web`: show a small badge/toast when a `change` for a `.sync-conflicts/*` path arrives.

### Tests
- Unit: clean concurrent edits to disjoint regions → merged, no note.
- Unit: overlapping edits to the same line → Conflict Note with correct frontmatter and
  server/client/base sections.
- Unit: base unrecoverable → conflict note (safe fallback), never a corrupted merge.
