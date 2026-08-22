# 13. Restore And Export

## What to build

Provide backup value through append-only restore commits and latest vault export. Support whole-vault restore from sealed history first, with per-file restore following the same new-commit model.

## Acceptance criteria

- [ ] A Vault Owner can view a vault-level sealed commit timeline.
- [ ] A Vault Owner can restore the whole Web Vault to a selected older commit.
- [ ] Restore creates a new current commit rather than moving history backward.
- [ ] Restored content updates R2 latest content, search, backlinks, tags, and connected Local Vaults like an ordinary change.
- [ ] A Vault Owner can restore an individual file to older content by creating a new commit.
- [ ] A Vault Owner can export the latest Vault Content as a zip.

## Blocked by

- 12. Offline Journal And Recovery
