# Cloudflare-Native Storage And Sync

## Status

Accepted, with storage roles updated by [ADR 0008](0008-yjs-crdt-sync-and-do-text-storage.md).

## Decision

Lapis uses Cloudflare Workers, Durable Objects, R2, Artifacts, and D1 because the product needs a self-deployable web vault with serialized vault coordination, fast reads, sealed Git history, and simple keyword search.

**Updated roles:**
- **Durable Object (per vault)** — hosts the authoritative `Y.Doc`, WebSocket Yjs sync, and SQLite persistence for text/CRDT state.
- **R2** — binary attachments only (plus any export/migration artifacts), not live markdown.
- **Artifacts / Git** — sealed history produced from debounced materialization of the Y.Doc.
- **D1** — auth, vault membership, devices, and FTS/backlinks/tags indexes rebuilt on debounce.
