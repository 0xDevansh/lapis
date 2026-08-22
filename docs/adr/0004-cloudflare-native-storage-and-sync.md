# Cloudflare-Native Storage And Sync

**Status:** Accepted — current (revision/patch sync; not Yjs).

Lapis uses Cloudflare Workers, Durable Objects, R2, Artifacts, and D1 because the product needs serialized sync writes, durable latest content, sealed Git history, and keyword search. Durable Objects coordinate each vault and hold the live manifest and durable **text** bodies in SQLite under [ADR 0010](0010-do-sqlite-text-and-conflict-resolve.md). **R2 holds binaries** and the optional manifest mirror. Artifacts is the Git-backed version-history store; D1 FTS indexes searchable content. Conflict records and resolution are defined by [ADR 0011](0011-structured-conflict-resolution.md).
