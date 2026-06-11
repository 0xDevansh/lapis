# 09. Plugin Patch Sync Online

## What to build

Implement online two-way sync between a connected Local Vault and Web Vault using filesystem watcher events, text file-diff patches, whole-object binary transfers, and manifest-based change application.

## Acceptance criteria

- [ ] The plugin detects local filesystem changes through a watcher.
- [ ] Text-like file changes are sent as file-diff patches against known base revisions.
- [ ] Binary attachment changes are uploaded as whole objects.
- [ ] Rename/move operations are sent explicitly when observed, with delete/create fallback.
- [ ] Accepted local changes update the Web Vault and become visible in R2 latest content.
- [ ] Web Vault changes are pulled and applied to the Local Vault.
- [ ] Periodic full scan fallback detects missed watcher events.

## Blocked by

- 08. Plugin Seed Local Vault
