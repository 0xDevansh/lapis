# Cloudflare-Native Storage And Sync

**Status:** Accepted — current (revision/patch sync; not Yjs).

Lapis uses Cloudflare Workers, Durable Objects, R2, Artifacts, and D1 because the product needs serialized sync writes, durable latest content, sealed Git history, and keyword search. Durable Objects coordinate each vault and hold the live manifest (and, under [ADR 0010](0010-do-sqlite-text-and-conflict-resolve.md), durable **text** bodies in DO SQLite). **R2 holds binaries** (and today still holds text until that migration ships). Artifacts is the Git-backed version-history store; D1 FTS indexes searchable content. Implementation plan: [`../proposals/sqlite-text-and-conflict-ux.md`](../proposals/sqlite-text-and-conflict-ux.md).
