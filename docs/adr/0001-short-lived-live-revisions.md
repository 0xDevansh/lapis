# Short-Lived Live Revisions Before Git Commits

## Status

**Superseded in part** by [ADR 0008](0008-yjs-crdt-sync-and-do-text-storage.md). The debounce-before-seal idea remains; the R2-as-live-text-revision model does not.

## Original decision

The web vault may expose server-accepted changes before those changes are sealed into Artifacts as Git commits, because near-immediate cross-client reflection is part of the product experience. These live revisions must be short-lived, with R2 updated immediately for browsing/sync and Artifacts commits created after a brief 2-10 second debounce, so the system preserves a simple recovery and rollback model without making every keystroke or small edit a separate commit.

## Current interpretation

- Live collaborative state is the in-memory / DO-persisted `Y.Doc`, synchronized immediately to connected peers.
- Debounced side effects still run after a quiet period: D1 search/backlinks/tags reindex, optional Git/Artifacts seal, soft-delete and orphan binary GC.
- Text is not flushed to R2 as the live mirror. Binaries still land in R2 when uploaded.
