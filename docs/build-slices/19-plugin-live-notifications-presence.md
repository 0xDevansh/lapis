# Slice 19 — Plugin live notifications and presence

## What to build

Replace the periodic-scan pull trigger with a WebSocket connection to the server's notify endpoint, so that changes made in the Web Vault (or from another synced device) appear in the Local Vault within ~1 s instead of up to 5 minutes.

### WebSocket client
- Connect to `GET /api/sync/:vaultId/notify?token=<syncToken>` using the global `WebSocket` constructor (available in Electron; no `requestUrl` needed).
- On `open`: set `isOnline = true`, trigger reconnect-recovery manifest diff if the socket was previously closed (see Slice 18 reconnect path).
- On `message`: parse the notification payload; handle `change`, `presence`, and `same_file_warning` types.
- On `close` or `error`: set `isOnline = false`, schedule reconnect with exponential backoff starting at 1 s, doubling to a cap of 30 s.
- On reconnect after backoff: perform a manifest diff first (to catch changes missed while the socket was down), then re-open the socket.
- Register the WebSocket teardown in `onunload` so it is closed cleanly when the plugin is disabled.

### Server-side note (small patch required)
The existing `GET /api/sync/:vaultId/notify` route authenticates via `Authorization: Bearer` header. The browser WebSocket API does not support custom headers. The server's `requireDevice` middleware must be extended to also accept the token from the `?token=` query parameter when the `Authorization` header is absent. This is a one-line change to the existing middleware (not a new server slice).

### Change notification handling
- Receive `{ type: "change", path, kind, revision?, newPath?, ts }`.
- Echo suppression: if `kind === "put"` and `journal.fileRevisions[lcPath] === revision`, this is the plugin's own push echoed back; skip.
- `kind === "put"`: pull file from `GET /api/sync/:vaultId/files/<path>`, write locally, update journal.
- `kind === "rename"`: rename local file (`vault.rename`), update journal keys.
- `kind === "delete"`: delete local file (`vault.delete`) if it exists, remove from journal.

### Presence display
- Receive `{ type: "presence", sessions: [{identity, openPath}] }`.
- Show a simple `Notice` listing other connected identities when the count changes (suppress on first connect to avoid noise).

### Same-file warning
- Receive `{ type: "same_file_warning", path, others: string[] }`.
- Show a persistent `Notice("Another session is editing <path>")`.

## Acceptance criteria

- [ ] Within ~1 s of a note being saved in the Web Vault, the change is pulled to local and visible in Obsidian.
- [ ] A rename performed in the Web Vault renames the local file (not delete + create).
- [ ] A delete in the Web Vault removes the local file.
- [ ] Echo suppression: saving a note locally, having it sync to the server, and receiving the change notification back does not trigger a redundant local write.
- [ ] Closing and reopening the network (or killing the WebSocket) triggers a reconnect; any changes made during the gap are picked up via manifest diff.
- [ ] Plugin unload closes the WebSocket cleanly.
- [ ] A same-file warning is displayed when another session opens the same file.

## Blocked by

- Slice 18 (offline/reconnect engine, `isOnline` flag).
- Slice 10 (server WebSocket notify endpoint) — complete.

## Server patch required

Extend `requireDevice` (or the notify route) to accept `?token=<syncToken>` as an alternative to the `Authorization: Bearer` header, for WebSocket upgrade requests where custom headers are not available.

## Test seam

`src/net/notify.ts` — the WebSocket wrapper accepts an injected `webSocketFactory: (url: string) => WebSocket`. Tests drive open/message/close events and verify backoff timing, reconnect behaviour, and manifest-diff trigger. Echo suppression tested by feeding a `change` notification with a revision matching the journal and verifying no pull is made.
