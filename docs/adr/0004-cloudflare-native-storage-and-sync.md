# Cloudflare-Native Storage And Sync

Lapis uses Cloudflare Workers, Durable Objects, R2, Artifacts, and D1 as its first-slice architecture because the product needs a self-deployable web vault with serialized sync writes, fast latest-file reads, sealed Git history, and simple keyword search. R2 is the latest Vault Content mirror, Artifacts is the Git-backed version-history store, Durable Objects coordinate each vault, and D1 FTS indexes searchable Vault Content.
