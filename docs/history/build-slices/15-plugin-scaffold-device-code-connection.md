# Slice 15 — Plugin scaffold and device-code connection

## What to build

Create the `plugin/` pnpm workspace package and implement the device-code connection flow. After this slice the plugin can be installed in Obsidian, connected to a running Lapis server, and have its sync token stored. No file sync yet.

### Package scaffold
- `plugin/` with `package.json` (pnpm, `obsidian` + `typescript` devDeps), `esbuild.config.mjs` (CJS, `es2021`, `obsidian`/`electron`/codemirror/builtins external), `tsconfig.json` (`strict`, `target ES2021`, `moduleResolution bundler`), `manifest.json` (`id: lapis-sync`, `isDesktopOnly: true`, `minAppVersion: 1.0.0`).
- Source structure: `src/main.ts` (lifecycle only), `src/settings.ts`, `src/types.ts`, `src/net/client.ts`, `src/net/device-auth.ts`, `src/ui/connect-modal.ts`, `src/ui/status.ts`.
- Add `plugin` to `pnpm-workspace.yaml`.

### Settings
- `LapisSettings { serverUrl: string, vaultId: string, syncToken: string, deviceName: string, receiveInternals: boolean, lastConnectedAt: string | null }` with sensible defaults.
- `LapisSettingTab` renders server URL, vault ID, and device name inputs. Sync token and connection state are read-only display fields.
- Settings persisted via `this.loadData() / this.saveData()`.

### Device-code connection
- `Lapis: Connect` command: validates `serverUrl` + `vaultId` are set, calls `POST /api/device-auth/request` with `{vaultId, deviceName}`, opens `ConnectModal` showing the user code (formatted as `XXXX-XXXX`) and a clickable link to the verification URI.
- `ConnectModal` polls `POST /api/device-auth/token` every 3 s. On `approved` response: stores the sync token via `saveSettings()`, dismisses modal, shows `Notice("Lapis: connected")`. On `denied` or `expired`: shows `Notice("Lapis: connection denied/expired")` and closes.
- `Lapis: Disconnect` command: clears `syncToken` + `lastConnectedAt` from settings, calls `Notice("Lapis: disconnected")`. Stops any running sync (no-op in this slice since sync is not yet built).
- Status bar item: shows `Lapis: connected` / `Lapis: not connected` based on whether `syncToken` is set.

### HTTP client
- `LapisClient` wraps `requestUrl` with `Authorization: Bearer <token>` and base URL from settings. `throw: false` on all calls so status codes are always inspectable. Exports `deviceAuthRequest()`, `deviceAuthToken()` in this slice; remaining sync methods added in later slices.

## Acceptance criteria

- [x] `pnpm build` inside `plugin/` produces `main.js` and type-checks cleanly.
- [x] `manifest.json` passes the Obsidian plugin validator (id, name, version, minAppVersion, description, isDesktopOnly all present).
- [x] Plugin loads in Obsidian without console errors when no settings are configured.
- [x] Settings tab shows server URL, vault ID, and device name inputs; values persist across Obsidian restarts.
- [x] Running `Lapis: Connect` with blank server URL or vault ID shows a validation error notice and does not make any network request.
- [x] Running `Lapis: Connect` with valid settings opens the `ConnectModal` displaying the user code and verification link.
- [x] After approving in the web UI, the modal dismisses automatically, status bar updates to "connected", and the token is present in `data.json` on disk.
- [x] Running `Lapis: Disconnect` clears the token, status bar shows "not connected".
- [x] Expiry during the poll shows an appropriate notice.

## Implementation notes

- Added a new `plugin/` pnpm workspace package with Obsidian's standard esbuild bundle shape (`main.js`, `manifest.json`, optional `styles.css`).
- Added `LapisSettings`, settings tab, status bar helper, device auth client, polling helper, connection modal, and `Connect` / `Disconnect` commands.
- Device auth uses `requestUrl` with `throw: false`; later slices will extend the same `LapisClient` for sync endpoints.
- Verified with `pnpm --filter plugin run build`.

## Blocked by

- Slice 07 (server device-code flow) — complete.

## Test seam

`src/net/device-auth.ts` — the poll loop accepts an injected `tokenFetcher: (deviceCode: string) => Promise<{status, token?}>`. Tests drive it through pending → approved, pending → denied, and pending → expired state sequences without importing `obsidian` or making real network calls.
