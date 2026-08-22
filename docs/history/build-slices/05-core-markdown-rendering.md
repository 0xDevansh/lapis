# 05. Core Markdown Rendering

## What to build

Render notes in the Web Vault with first-slice Core Rendering: Markdown, wikilinks with aliases, broken-link styling, tags/frontmatter extraction hooks, common callouts, built-in themes, and attachment/image rendering.

## Acceptance criteria

- [x] Markdown notes render in preview/read mode by default.
- [x] Source editing remains available on demand.
- [x] Wikilinks resolve to notes and support aliases like `[[Note|label]]`.
- [x] Broken wikilinks render in a distinct color and show a tooltip on hover.
- [x] Broken wikilinks offer a create-note action.
- [x] Images and common attachments render or open where feasible.
- [x] Built-in themes can be selected for the Web Vault reading experience.
- [x] Community plugin execution and plugin runtime compatibility are not implemented.

## Implementation notes

### Dependencies
- `marked@^15` — CommonMark + GFM Markdown parser with custom extension API
- `gray-matter@^4` — YAML frontmatter extraction
- `dompurify@^3` — HTML sanitization before dangerouslySetInnerHTML

### New files
- `web/src/markdown/wikilinks.ts` — `parseWikilinks`, `tokenize`, `resolveWikilink`. Obsidian resolution order: exact path match, then basename-anywhere match.
- `web/src/markdown/frontmatter.ts` — `parseFrontmatter` wrapping gray-matter; extracts tags from frontmatter `tags` field and inline `#tag` patterns.
- `web/src/markdown/renderer.ts` — `renderMarkdown(source, options)`:
  - Custom marked `wikilink` inline extension handles `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`
  - Broken links get `class="wikilink-broken"` and `data-create-path` attribute
  - Resolved wikilinks generate `/vault/:id/<path>` hrefs
  - Image embeds generate authenticated `<img>` tags pointing to `/api/vaults/:id/files/<path>`
  - `processCallouts` post-processes `<blockquote>` with `[!TYPE]` into structured `<div class="callout callout-TYPE">` HTML
  - DOMPurify sanitization with allowlist (all Markdown output tags + `data-create-path` attribute)
- `web/src/components/MarkdownView.tsx` — React component: renders frontmatter header (title, tags), then DOMPurified HTML. Intercepts clicks: broken links → `onCreateNote`, internal vault links → `onNavigate` or `navigate()`.
- `web/src/hooks/useTheme.ts` — `useTheme()` hook: persists selection to localStorage, applies `data-theme` attribute on `<html>`.

### CSS (`web/src/index.css`)
- `.markdown-body` typography: headings, paragraphs, lists, code blocks (dark background), blockquotes, tables, hr, links, images
- `.wikilink` / `.wikilink-broken` — wikilink styling (broken: purple + dotted underline)
- `.callout` / `.callout-title` / `.callout-body` — Obsidian-style callout blocks with per-type colors (note, warning, danger, success, info)
- `[data-theme="dark"]` and `[data-theme="sepia"]` — full CSS variable overrides for dark/sepia themes

### Integration
- `VaultBrowserPage`: Markdown files (`.md` or `text/markdown`) now use `MarkdownView` instead of `<pre>`. Theme selector (☀/🌙/📜) in sidebar. `vaultPaths` passed to enable wikilink resolution against live manifest.

## Blocked by

- 03. Web File Operations With Live Revisions
