# 02. R2-Backed Vault Content Browser

## What to build

Add the first useful Web Vault browsing path: store latest Vault Content in R2, maintain a manifest, and let an authenticated Vault Owner browse folders and open files from the web UI.

## Acceptance criteria

- [x] A Web Vault has a latest-content manifest stored and served through authenticated APIs.
- [x] The UI shows a folder tree for Vault Content.
- [x] The UI opens Markdown files and common attachment metadata from R2-backed latest content.
- [x] Vault Internals are not shown in the normal browser.
- [x] Safe path validation blocks traversal, absolute paths, control characters, and reserved sync paths except `.sync-conflicts/`.
- [x] Case-only duplicate visible paths are prevented.

## Implementation notes

### Worker

- `worker/src/vault/path.ts` — `isValidVaultPath` / `isVaultInternal` / `validateVaultPath`. Blocks: leading `/`, control chars, `..` segments, empty segments, `.obsidian/`, `.trash/`, `_manifest.json`. Allows `.sync-conflicts/`.
- `worker/src/vault/manifest.ts` — `VaultManifest` / `ManifestEntry` types, `emptyManifest`, `hasCaseDuplicate`, `manifestKey`, `contentKey`. Manifest stored at `<vaultId>/_manifest.json` in R2. Keys indexed by lower-cased path for case-duplicate detection.
- `worker/src/vault/coordinator.ts` — extended with `getManifest`, `putFile` (validates path, prevents case duplicates, writes R2 + manifest), `deleteFile` (removes R2 object + manifest entry). All operations serialized by the DO.
- `worker/src/vault/routes.ts` — two new authenticated routes:
  - `GET /api/vaults/:id/manifest` — returns manifest JSON (ownership-gated)
  - `GET /api/vaults/:id/files/*` — streams R2 object; blocks vault internals

### Web

- `web/src/api.ts` — added `ManifestEntry`, `VaultManifest`, `getManifest`, `getFileText`, `fileUrl`
- `web/src/components/FolderTree.tsx` — `buildTree` (folders before files, alphabetical), recursive `FolderTree` / `FolderItem` / `FileItem` components with expand/collapse state
- `web/src/pages/VaultBrowserPage.tsx` — split-pane layout (260 px sidebar + scrollable content pane). Sidebar shows folder tree. Content pane: text/Markdown shown as raw source in `<pre>`, images shown inline, binary files show metadata + download link
- `web/src/App.tsx` — `/vault/:id/*` wired to `VaultBrowserPage`

## Blocked by

- 01. Deployable Shell And Web Vault Creation
