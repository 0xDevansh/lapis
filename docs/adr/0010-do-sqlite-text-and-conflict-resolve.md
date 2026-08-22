# ADR 0010 — Text latest in DO SQLite; binaries on R2; explicit conflict resolve

**Status:** Accepted (2026-08-22) — implementation in progress via [`../proposals/sqlite-text-and-conflict-ux.md`](../proposals/sqlite-text-and-conflict-ux.md).

## Context

Revision/patch sync already treats the vault Durable Object as authority for text. Flushing full Markdown bodies to R2 every ~10s is the wrong grain: chatty puts, rewrite amplification, and a lagging second copy. Conflict UX is only `.sync-conflicts/` notes plus weak client handling; `Device.resolveConflict` is a stub.

## Decision

1. **All `isTextContentType` latest content** lives in DO SQLite (chunked). **No R2 for text** after migration. Binaries stay on R2. Seal/zip/GitHub read text from SQLite.
2. **Ancestor retention** for merge: one full-text **checkpoint at `minAck`** (least common acked revision across retained devices) plus forward unified diffs to head. Advancing acks moves the checkpoint and drops obsolete diffs.
3. **Conflicts:** keep writing Conflict Notes while open; expose structured `conflict` on write/notify; **resolve API** (keep-server / keep-client / use-merged) **hard-deletes** the note; wire real `Device.resolveConflict`; ship **web UX before plugin**.

## Consequences

- Implements as slices S0–S8 in the proposal doc; `storage_version` 2 marks migrated vaults.
- ADR 0004’s “R2 is the latest Vault Content mirror” is amended for **text**; R2 remains latest for **binaries** and optional manifest JSON.
- Conflict Notes remain durable while unresolved; resolution is an explicit product action, not “delete the note by hand only.”
