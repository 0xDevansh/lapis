# 10. Live Notifications And Presence

## What to build

Add WebSocket-based vault change notifications, reconnect recovery through manifest diff, lightweight session/device presence, and same-file editing warnings without locks.

## Acceptance criteria

- [x] Connected clients receive accepted change notifications under normal conditions in about one second.
- [x] Notification payloads are small and cause clients to fetch changed content from authenticated APIs/R2-backed reads.
- [x] Reconnected clients recover missed changes by comparing their revision/manifest with the server manifest.
- [x] The Web Vault shows active sessions/devices.
- [x] The Web Vault warns when another session is on the same file.
- [x] Presence never blocks editing.

## Blocked by

- 09. Plugin Patch Sync Online

## Implementation notes

### Server
- `VaultCoordinator` extended with hibernatable WebSocket support (`ctx.acceptWebSocket`).
- In-memory `presence` map (`Map<WebSocket, {identity, openPath}>`).
- `broadcast(message)` method fans out JSON payloads to all connected sockets.
- Every file mutation (`putFile`, `renameFile`, `deleteFile`, `syncPutFile`, `syncApplyPatch`) calls `broadcast` with a `ChangeNotification`.
- `webSocketMessage` handles `{"type":"open","path":"..."}` (tracks open file, emits same-file warning) and `{"type":"close_file"}`.
- `webSocketClose` / `webSocketError` remove from presence and broadcast updated presence snapshot.
- `GET /ws?identity=<id>` route in `coordinator.fetch()` handles the WebSocket upgrade.

### New files
- `worker/src/notify/routes.ts`:
  - `GET /api/vaults/:id/notify` (session auth) → forwards WebSocket upgrade to `VaultCoordinator` DO.
  - `GET /api/sync/:vaultId/notify` (device auth) → same, with device identity.
- `web/src/hooks/useVaultNotify.ts` — `useVaultNotify(vaultId, openPath, options)`: manages WebSocket lifecycle, exponential reconnect backoff, delivers typed messages.
- `web/src/components/PresenceBar.tsx` — shows connection status dot, active session count, same-file warning with dismiss.

### CSS
- `.presence-bar`, `.presence-dot--online/offline`, `.presence-warning`, `.presence-warning-dismiss` added to `index.css`.
