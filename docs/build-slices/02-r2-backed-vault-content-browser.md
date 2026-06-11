# 02. R2-Backed Vault Content Browser

## What to build

Add the first useful Web Vault browsing path: store latest Vault Content in R2, maintain a manifest, and let an authenticated Vault Owner browse folders and open files from the web UI.

## Acceptance criteria

- [ ] A Web Vault has a latest-content manifest stored and served through authenticated APIs.
- [ ] The UI shows a folder tree for Vault Content.
- [ ] The UI opens Markdown files and common attachment metadata from R2-backed latest content.
- [ ] Vault Internals are not shown in the normal browser.
- [ ] Safe path validation blocks traversal, absolute paths, control characters, and reserved sync paths except `.sync-conflicts/`.
- [ ] Case-only duplicate visible paths are prevented.

## Blocked by

- 01. Deployable Shell And Web Vault Creation
