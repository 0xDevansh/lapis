# 12. Offline Journal And Recovery

## What to build

Make the Obsidian plugin robust offline by keeping a lightweight local sync journal, replaying changes when connectivity returns, and falling back to full scan if journal state is invalid.

## Acceptance criteria

- [ ] The plugin stores last synced revision, file hashes, and pending local operations.
- [ ] Local changes made offline are replayed in order when the plugin reconnects.
- [ ] Replayed patches use normal server merge/conflict behavior.
- [ ] If the journal is corrupt or incomplete, the plugin performs a full scan against the latest manifest.
- [ ] Reconnect after missed WebSocket notifications is recovered by manifest diff.
- [ ] Offline recovery does not silently overwrite newer Web Vault changes.

## Blocked by

- 11. Server-Side Merge And Conflict Notes
