# 06. Search, Backlinks, And Tags

## What to build

Index latest Vault Content for simple keyword search, backlinks, and tags. Use D1 FTS for filename/content search and server-side wikilink parsing for backlinks.

## Acceptance criteria

- [x] Accepted revisions update a D1 FTS index for Vault Content only.
- [x] Search supports simple filename and Markdown content keyword queries.
- [x] Search results include path and snippet or heading context.
- [x] Backlinks are computed server-side from wikilinks in latest Vault Content.
- [x] Tags are extracted from Markdown content and frontmatter.
- [x] Vault Internals are excluded from search, backlinks, and tag indexes.

## Blocked by

- 03. Web File Operations With Live Revisions
- 05. Core Markdown Rendering

## Implementation notes

### D1 schema additions (`worker/src/db/schema.sql`)
- `vault_fts` — FTS5 virtual table with `porter unicode61` tokenizer. Columns: `vault_id` (unindexed), `path` (unindexed), `filename`, `content`. One row per vault file. Non-Markdown files have empty `content` but are still indexed by filename.
- `backlinks` — `(vault_id, source_path, target_path)` rows. Populated by server-side wikilink extraction on every `putFile`/`renameFile`. Indexed on both source and target.
- `note_tags` — `(vault_id, note_path, tag)` rows. One row per (note, tag) pair. Populated from frontmatter `tags:` field and inline `#tag` patterns.

### Worker: indexer (`worker/src/search/indexer.ts`)
- `indexFile(db, {vaultId, path, content, vaultPaths})` — runs as fire-and-forget after every `putFile`. Deletes existing FTS/backlinks/tags rows then inserts fresh ones. FTS content strips frontmatter YAML before indexing.
- `removeFromIndex(db, vaultId, path)` — called after `deleteFile`.
- `renameInIndex(db, vaultId, oldPath, newPath, newContent, vaultPaths)` — called after `renameFile`; removes old entry, inserts new one.
- Wikilink extraction: server-side regex matching `[[target]]`, strips `|alias` and `#heading`. Resolves targets against current vault paths using the same two-step algorithm as the front-end (exact → basename).
- Tags: extracts from frontmatter `tags:` YAML field (inline list and block list) + inline `#tag` patterns in body.
- Vault Internals check at entry point — `.obsidian/` and similar are never indexed.

### Worker: search routes (`worker/src/search/routes.ts`)
- `GET /api/vaults/:id/search?q=` — D1 FTS5 with BM25 ranking (`bm25(vault_fts, 0, 0, 1, 10)` weights filename+content, content 10×). Returns up to 20 results with `path` + `snippet` (terms highlighted with `**`). Query is sanitised and last token gets `*` for prefix search.
- `GET /api/vaults/:id/backlinks?path=` — returns list of `{sourcePath}` objects for all notes linking to `path`.
- `GET /api/vaults/:id/tags` — returns `{tag, count}[]` sorted by count then name.
- Routes mounted at `/api/vaults` alongside `vaultRoutes`.

### Web: API helpers (`web/src/api.ts`)
- `searchVault(vaultId, q)` → `SearchResult[]`
- `getBacklinks(vaultId, path)` → `BacklinkResult[]`
- `getVaultTags(vaultId)` → `TagResult[]`

### Web: UI components
- `SearchPanel` (`web/src/components/SearchPanel.tsx`) — debounced (300ms) search input in sidebar; renders results as clickable path + snippet rows; `**bold**` markers rendered as `<strong>`.
- `BacklinksPanel` (`web/src/components/BacklinksPanel.tsx`) — rendered at bottom of Markdown view; lists notes that link to the open file; click navigates to source.
- `VaultBrowserPage` — `SearchPanel` inserted between theme row and file tree; `BacklinksPanel` appended inside `.markdownScroll` div after `MarkdownView`.

### Dev migration
`/api/admin/migrate` now creates all three new tables/indexes in sequence.
