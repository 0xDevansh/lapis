# 06. Search, Backlinks, And Tags

## What to build

Index latest Vault Content for simple keyword search, backlinks, and tags. Use D1 FTS for filename/content search and server-side wikilink parsing for backlinks.

## Acceptance criteria

- [ ] Accepted revisions update a D1 FTS index for Vault Content only.
- [ ] Search supports simple filename and Markdown content keyword queries.
- [ ] Search results include path and snippet or heading context.
- [ ] Backlinks are computed server-side from wikilinks in latest Vault Content.
- [ ] Tags are extracted from Markdown content and frontmatter.
- [ ] Vault Internals are excluded from search, backlinks, and tag indexes.

## Blocked by

- 03. Web File Operations With Live Revisions
- 05. Core Markdown Rendering
