# 10. Live Notifications And Presence

## What to build

Add WebSocket-based vault change notifications, reconnect recovery through manifest diff, lightweight session/device presence, and same-file editing warnings without locks.

## Acceptance criteria

- [ ] Connected clients receive accepted change notifications under normal conditions in about one second.
- [ ] Notification payloads are small and cause clients to fetch changed content from authenticated APIs/R2-backed reads.
- [ ] Reconnected clients recover missed changes by comparing their revision/manifest with the server manifest.
- [ ] The Web Vault shows active sessions/devices.
- [ ] The Web Vault warns when another session is on the same file.
- [ ] Presence never blocks editing.

## Blocked by

- 09. Plugin Patch Sync Online
