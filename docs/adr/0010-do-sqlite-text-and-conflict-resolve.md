# ADR 0010 — Store text in Durable Object SQLite with ack-bounded history

**Status:** Accepted (2026-08-22)

## Context

Revision/patch sync already treats the vault Durable Object as authority for text. Flushing full text bodies to R2 every few seconds created chatty puts, rewrite amplification, and a lagging second copy. Reconstructing stale client bases also needs bounded historical text that survives process eviction.

## Decision

1. All `isTextContentType` latest content lives in the vault Durable Object's SQLite database. Bodies are split into UTF-8-safe chunks; oversized text never spills to R2.
2. R2 stores binary bodies and the optional manifest mirror only. Seal, zip, search indexing, and Git adapters read text through the coordinator.
3. Existing vaults migrate each text head from R2, verify the SQLite copy, create an initial checkpoint, delete the legacy object, then set `storage_version = 2`.
4. Each text path retains one full checkpoint at `minAck` plus contiguous canonical forward diffs to head. `minAck` is the least acknowledgement across retained clients.
5. Plugin devices inactive for 30 days and browser acknowledgements older than 24 hours stop pinning history. When `minAck` advances, the checkpoint advances and obsolete diffs are deleted.
6. If a requested base is older than the checkpoint or reconstruction is corrupt/gapped, the write takes the conflict path. It must not use the current head as a substitute base.

## Consequences

- SQLite is the sole live text authority and must be monitored for database size and diff-chain growth.
- Clients acknowledge only revisions they have successfully applied; a false acknowledgement can discard a needed ancestor.
- Abandoned clients eventually trade mergeability for bounded storage and may receive a Conflict Note on return.
- ADR 0004's “R2 is the latest Vault Content mirror” is amended for text; it remains true for binaries.
- Structured conflict behavior and UX are decided separately in [ADR 0011](0011-structured-conflict-resolution.md).
- The detailed implementation and alternatives remain in [`../proposals/sqlite-text-and-conflict-ux.md`](../proposals/sqlite-text-and-conflict-ux.md).
