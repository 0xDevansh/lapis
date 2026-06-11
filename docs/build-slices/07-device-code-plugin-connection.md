# 07. Device-Code Plugin Connection

## What to build

Connect the Obsidian plugin to Lapis with a device-code flow, revocable per-device credentials, and a visible device list for each Web Vault.

## Acceptance criteria

- [x] The plugin can start a device-code connection flow for a selected Web Vault.
- [x] The Vault Owner can approve the device from the authenticated web product.
- [x] Each connected Local Vault/device receives revocable sync credentials that are not Artifacts tokens.
- [x] The Web Vault shows connected devices.
- [x] A Vault Owner can revoke a device and prevent further sync from it.
- [x] Each device can configure whether it wants to receive Vault Internals updates.

## Blocked by

- 01. Deployable Shell And Web Vault Creation

## Implementation notes

### D1 schema additions (`worker/src/db/schema.sql`)
- `device_codes` — pending flows: `device_code` (secret, sent to plugin), `user_code` (short human-readable, shown in web UI), `vault_id`, `owner_id`, `device_name`, `status` (pending/approved/denied), `expires_at` (10 min TTL), `created_at`.
- `devices` — approved devices: `id`, `vault_id`, `owner_id`, `device_name`, `sync_token` (unique Bearer secret), `receive_internals` (0/1), `revoked` (0/1), `created_at`, `last_seen_at`.

### Worker: device routes (`worker/src/device/routes.ts`)
Mounted at `/api` so that:
- `POST /api/device-auth/request` — unauthenticated; creates pending flow; returns `deviceCode`, `userCode`, `verificationUri`, `expiresIn`.
- `POST /api/device-auth/token` — unauthenticated plugin poll; returns 202 `{status:"pending"}`, 200 `{token}` (creates device row on first approved poll), or 400 on denied/expired/not_found.
- `GET /api/vaults/:id/devices/pending` — vault-owner auth; returns pending user codes (auto-cleans expired).
- `POST /api/vaults/:id/devices/approve` — vault-owner auth; sets status to "approved".
- `POST /api/vaults/:id/devices/deny` — vault-owner auth; sets status to "denied".
- `GET /api/vaults/:id/devices` — vault-owner auth; returns active (non-revoked) devices.
- `DELETE /api/vaults/:id/devices/:deviceId` — vault-owner auth; sets `revoked=1`.
- `PATCH /api/vaults/:id/devices/:deviceId` — vault-owner auth; updates `receive_internals`.

### Worker: sync auth middleware (`worker/src/middleware/syncAuth.ts`)
- `requireDevice` middleware: validates `Authorization: Bearer <syncToken>`, rejects revoked tokens, updates `last_seen_at`, sets `c.set('device', {id, vaultId, deviceName, receiveInternals})`.

### User code format
XXXX-XXXX with chars excluding easily confused characters (no 0/O/1/I).

### Web: API helpers (`web/src/api.ts`)
`requestDeviceCode`, `pollDeviceToken`, `getPendingDevices`, `approveDevice`, `denyDevice`, `listDevices`, `revokeDevice`, `updateDevice`.

### Web: DevicesPage (`web/src/pages/DevicesPage.tsx`)
- Two sections: "Pending Approvals" (table with Code, Device name, Requested, Expires; Approve/Deny buttons) and "Connected Devices" (table with Device name, Connected, Last seen, Vault Internals toggle; Revoke button).
- Pending section auto-polls every 5s.
- Route: `/vault/:id/devices` — linked from vault browser sidebar as "Devices".
