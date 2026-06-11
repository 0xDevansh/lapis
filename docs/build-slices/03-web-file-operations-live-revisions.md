# 03. Web File Operations With Live Revisions

## What to build

Make the Web Vault editable end-to-end by supporting create, edit, upload, rename, move, and delete operations against R2 latest content through the vault coordinator, with live revisions visible immediately to the browser.

## Acceptance criteria

- [x] A Vault Owner can create and edit Markdown notes in the web UI.
- [x] A Vault Owner can upload, rename, move, and delete Vault Content.
- [x] Deletes update the manifest as recoverable synced operations.
- [x] The vault coordinator serializes concurrent mutations for a single Web Vault.
- [x] Accepted changes update R2 and the manifest immediately.
- [x] OS junk and cache files are ignored by default when accepted through sync/import paths.

## Implementation notes

### Worker

- `worker/src/vault/path.ts` — added `isOsJunk`: filters `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` macOS shadows, temp/swap extensions (`.crdownload`, `.part`, `.tmp`, `.swp`, `.swo`)
- `worker/src/vault/manifest.ts` — added `isAncestorPath` guard used during rename/move
- `worker/src/vault/coordinator.ts` — added `renameFile(vaultId, oldPath, newPath)`: copies R2 object to new key, updates manifest atomically, deletes old key. Guards: path validity, vault-internal check, case-duplicate at destination, ancestor-path cycle
- `worker/src/vault/routes.ts` — three new authenticated routes:
  - `PUT /api/vaults/:id/files/*` — create/replace file. JSON body `{content}` for text; raw bytes for binary. OS-junk paths rejected with 400. Content-Type inferred from extension when JSON wrapper used.
  - `PATCH /api/vaults/:id/files/*` — rename/move. Body: `{newPath}`
  - `DELETE /api/vaults/:id/files/*` — remove from manifest + R2

### Web

- `web/src/api.ts` — added `putTextFile`, `uploadFile`, `renameFile`, `deleteFile`
- `web/src/components/FolderTree.tsx` — `FileItem` now shows hover-reveal Rename (✎) and Delete (✕) action buttons; accepts `onRename`/`onDelete` props threaded through `FolderTree`/`FolderItem`
- `web/src/pages/VaultBrowserPage.tsx` — full rewrite with:
  - "+ Note" / "↑ Upload" toolbar buttons in sidebar
  - `FileView` supports `editing` state: full-height textarea with Save/Cancel
  - Rename and Delete modal dialogs
  - `refreshManifest` pattern: every mutation re-fetches manifest to keep tree in sync

## Blocked by

- 02. R2-Backed Vault Content Browser
