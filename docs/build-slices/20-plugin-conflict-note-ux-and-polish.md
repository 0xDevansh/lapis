# Slice 20 — Conflict-note UX, Vault Internals opt-in, and polish

## What to build

Surface Conflict Notes clearly to the Vault Owner, make the Vault Internals opt-in work end-to-end, and deliver a release-ready plugin (clean README, correct `versions.json`, build pipeline, installation instructions).

### Conflict-note UX
- At startup and after every sync cycle, scan `journal.fileRevisions` for paths under `.sync-conflicts/` (or query the local vault for files in that folder) and count them.
- Status bar: append `(N conflict(s))` in amber when count > 0.
- `Lapis: Open conflicts folder` command: calls `app.workspace.revealInFolder` on `.sync-conflicts/` to open it in the file explorer.
- When a Conflict Note is deleted locally, the next sync cycle detects the delete event, sends it to the server, and removes it from the conflict count.
- On first-connect reconcile and batch replay, Conflict Notes returned as `conflictPath` in server responses are pulled to local immediately so they appear without waiting for the next periodic scan.

### Vault Internals opt-in
- `receiveInternals` toggle in settings tab (`PluginSettingTab`). Default: off.
- When the toggle changes: call `PATCH /api/vaults/:id/devices/:deviceId` with `{receiveInternals: boolean}` to update the server-side device record. The plugin must store its `deviceId` (returned from the `POST /api/device-auth/token` response) alongside the `syncToken` in settings.
- When `receiveInternals` is on and a remote change notification (or manifest diff) includes a path under `.obsidian/`: write via `vault.adapter.writeBinary` (for binaries) or `vault.adapter.write` (for text), bypassing the normal `vault.create/modify` methods that would refuse to touch hidden paths.
- During seed (`receiveInternals` on): also upload the local `.obsidian/` tree.

### Plugin build pipeline
- `pnpm build` in `plugin/` runs `tsc -noEmit -skipLibCheck` then `node esbuild.config.mjs production`.
- `pnpm dev` in `plugin/` runs `node esbuild.config.mjs` (watch mode).
- Root `package.json` scripts: `"plugin:dev"`, `"plugin:build"` delegating to `pnpm --filter plugin run dev/build`.
- `versions.json` maps plugin version to minimum Obsidian app version.

### README and documentation
- `plugin/README.md`: one-paragraph description, prerequisites (Lapis server deployed, Obsidian 1.0+), installation steps (copy `main.js` + `manifest.json` to vault `.obsidian/plugins/lapis-sync/`), quick-start (configure server URL + vault ID → Connect command → approve in browser), and disclosure of the external Lapis server as a required service.
- Update root `README.md` to mention the plugin and link to `plugin/README.md`.

## Acceptance criteria

- [ ] Status bar shows conflict count in amber when `.sync-conflicts/` contains files; count is 0 when the folder is empty.
- [ ] `Lapis: Open conflicts folder` command opens the `.sync-conflicts/` folder in the Obsidian file explorer.
- [ ] Deleting a Conflict Note in Obsidian removes it from the server and decrements the status bar count.
- [ ] Enabling `receiveInternals` and syncing causes `.obsidian/` content from the Web Vault to be written locally.
- [ ] Disabling `receiveInternals` stops any `.obsidian/` files from being written, even if the server sends them.
- [ ] The server's device record `receive_internals` field matches the plugin's toggle state.
- [ ] `pnpm build` in `plugin/` produces `main.js` with no TypeScript errors and no bundler warnings.
- [ ] `plugin/README.md` clearly discloses the external Lapis server and provides installation steps.

## Blocked by

- Slice 19 (live notifications — needed for instant conflict-note delivery).
- Slice 11 (server Conflict Note creation) — complete.

## Test seam

Conflict count logic in `src/ui/status.ts` is a pure function `countConflicts(journalPaths: string[]): number` — tested directly. `receiveInternals` toggling in `src/sync/engine.ts` — verify that Vault Internal paths are written via `adapter.write` (not `vault.modify`) and that toggling off skips the write entirely.
