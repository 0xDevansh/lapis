# ADR 0011 — Resolve sync conflicts through structured server records

**Status:** Accepted (2026-08-22)

## Context

Conflict Notes make unsafe merges visible and recoverable, but a note alone does not give clients a durable workflow. Reloads can lose transient conflict state, clients cannot reliably choose a version, and deleting a note by hand does not atomically resolve the underlying conflict.

## Decision

1. Unsafe text merges, garbage-collected ancestors, and stale binary writes create both a Markdown Conflict Note and an open structured conflict row in the vault Durable Object.
2. The structured payload identifies the original path, note path, server/client revisions, binary status, and available server, client, and base content. Large content is chunked in SQLite.
3. Write responses and WebSocket notifications carry the structured conflict. Authenticated web and device routes list open conflicts after reload or reconnect.
4. Resolution is an explicit API action:
   - `keep-server` leaves the current head unchanged;
   - `keep-client` commits the captured client version; and
   - `use-merged` commits caller-supplied merged text.
5. A successful resolution marks the conflict resolved, broadcasts `conflict_resolved`, updates the resolving client's revision state, and hard-deletes the Conflict Note. Failed note cleanup is retried by the coordinator alarm.
6. Web and Obsidian clients expose persistent conflict counts, server/client/base review, and the same three actions through `Device.resolveConflict`.

## Consequences

- The server, not transient UI state, is authoritative for whether a conflict is open.
- The main path is never silently clobbered when merge safety is unknown.
- Resolved notes do not accumulate as user-visible vault content.
- Resolution attempts against an already resolved or mismatched conflict fail instead of applying twice.
- Conflict rows retain small resolution metadata for operational resolution-rate metrics; captured content chunks are deleted on resolve.
- Binary conflicts can keep the server version through this flow; replacing binary content remains an explicit upload.
