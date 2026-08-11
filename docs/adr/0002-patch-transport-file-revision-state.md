# Patch Transport With File Revision State

## Status

**Superseded** by [ADR 0008](0008-yjs-crdt-sync-and-do-text-storage.md).

## Original decision

Clients send file-diff patches for text-like vault content to reduce sync payload size, while binary attachments use whole-object transfers. The server applies patches against known base revisions and stores the accepted result as a normal file revision, with server-side three-way merge attempted when a patch is stale, so the product avoids realtime collaborative editing protocols while still syncing efficiently.

## Why superseded

Multi-user collaborative vaults require conflict-free concurrent editing. Per-file revisions + `merge3` + Conflict Notes do not scale to that model. Sync is now Yjs over WebSocket; text lives in Durable Object storage; binaries remain whole-object R2 with last-write-wins.
