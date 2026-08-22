# ADR 0012 — Seal binaries as Lapis-managed Git LFS pointers

**Status:** Accepted (2026-08-23)

## Context

Binary vault files can exceed Durable Object RPC and memory limits when sealing Git history. Staging large uploads through R2 avoids the RPC limit, but sealing still used to load binary bodies into an in-memory Git checkout and pack them as full Git blobs.

Git LFS pointer files solve the Git-history part of this problem: Git stores a small text pointer with a SHA-256 object id and byte size, while the actual binary object lives outside Git.

## Decision

1. Lapis stores binary content as immutable R2 blobs keyed by SHA-256:
   `<vaultId>/_blobs/sha256/<oid>`.
2. Binary manifest entries persist the blob OID and R2 key. Text files remain authoritative in Durable Object SQLite.
3. Binary uploads are staged through R2 and committed to the coordinator as metadata after checksum calculation. Duplicate content reuses the existing blob.
4. Binary renames and deletes update live manifest metadata only. Historical blobs are retained because sealed Git commits may still reference them.
5. Sealing writes ordinary Git blobs for text and standard Git LFS pointer blobs for binaries. The sealer builds commits from Git tree object IDs and does not check out binary worktrees.
6. Git inbound reconciliation treats LFS pointers as binary metadata and does not feed pointer text into text merge logic.
7. External `git-lfs clone`, `pull`, and `push` support is intentionally out of scope for this decision.

## Consequences

- Large binaries no longer need to pass through Durable Object RPC or be materialized during sealing.
- Renaming a binary no longer copies bytes or races a deferred R2 path-key move.
- Sealed Git history remains useful for text and for binary identity, but external Git clients will see pointer files unless a future LFS Batch API gateway is added.
- A future external gateway needs authenticated batch and transfer endpoints, repository `.gitattributes` / `.lfsconfig`, GitHub OAuth through Better Auth, and a disabled state when GitHub OAuth is not configured.
- Blob garbage collection is deferred until retained Git history and live references can be scanned safely.
