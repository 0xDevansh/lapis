# 03. Web File Operations With Live Revisions

## What to build

Make the Web Vault editable end-to-end by supporting create, edit, upload, rename, move, and delete operations against R2 latest content through the vault coordinator, with live revisions visible immediately to the browser.

## Acceptance criteria

- [ ] A Vault Owner can create and edit Markdown notes in the web UI.
- [ ] A Vault Owner can upload, rename, move, and delete Vault Content.
- [ ] Deletes update the manifest as recoverable synced operations.
- [ ] The vault coordinator serializes concurrent mutations for a single Web Vault.
- [ ] Accepted changes update R2 and the manifest immediately.
- [ ] OS junk and cache files are ignored by default when accepted through sync/import paths.

## Blocked by

- 02. R2-Backed Vault Content Browser
