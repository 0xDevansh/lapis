# Plugin Sync Journal And First-Connect Reconcile

## Status

**Superseded** by [ADR 0008](0008-yjs-crdt-sync-and-do-text-storage.md).

## Original decision

The Obsidian plugin kept a revision-keyed `SyncJournal`, queued offline patch/PUT ops, and reconciled first connect via server-side three-way merge / Conflict Notes. See git history for the full prior text.

## Replacement

The plugin is a Yjs peer:
- Syncs over the device-authenticated Yjs WebSocket.
- Persists local Yjs state for offline editing; merges on reconnect via CRDT.
- Maps filesystem create/edit/rename/delete to stable `fileId` operations (path is metadata).
- First connect assigns ids and merges local files into the shared `Y.Doc`, then materializes disk from CRDT state.
- Echo suppression prevents remote path ops from bouncing back into the CRDT.
