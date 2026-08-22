# Lapis Obsidian Plugin PRD

## Problem Statement

A Vault Owner who uses Lapis to access their notes in a browser still has to choose between two disjointed workflows: keep editing in Obsidian on their primary device, or switch to the Web Vault. There is no automatic bridge between them. Changes made in Obsidian are invisible in the Web Vault until the owner manually uploads them, and changes made in the Web Vault (edits, renames, new notes from wikilink creation) never appear locally at all.

The missing piece is a locally-installed companion that watches the Local Vault, pushes changes to the Web Vault as they happen, pulls remote changes down, and keeps both sides coherent even when the device is temporarily offline.

## Solution

An Obsidian community plugin that acts as a sync agent between the Local Vault and the Web Vault. The plugin connects once via a device-code flow (no pasting long secrets), then runs silently in the background: watching for local file changes, patching or uploading them to the server, pulling remote changes down, queuing work offline and replaying it on reconnect, and surfacing merge conflicts as Conflict Notes with explicit resolve actions (keep server / keep mine / manual merge — see [ADR 0011](../adr/0011-structured-conflict-resolution.md)).

The server already implements the sync protocol. The plugin is a client that speaks it.

## User Stories

### Connection and credentials
1. As a Vault Owner, I want to connect my Local Vault to a specific Web Vault using a short user code so that I never have to paste a long secret into Obsidian.
2. As a Vault Owner, I want the plugin to show me the user code and a link to the Web Vault approval page in a modal so that I can approve the connection without leaving Obsidian.
3. As a Vault Owner, I want the plugin to poll for approval automatically and dismiss the modal when the connection is established so that I do not have to manually confirm anything after approving.
4. As a Vault Owner, I want the plugin to store my sync token securely inside the vault's plugin data so that I do not have to reconnect after restarting Obsidian.
5. As a Vault Owner, I want a disconnect command that clears my credentials and stops all sync activity so that I can cleanly unlink a device.
6. As a Vault Owner, I want the status bar to show whether the plugin is connected, syncing, offline, or has unresolved conflicts so that I always know the current state at a glance.
7. As a Vault Owner, I want to enter the server URL and vault ID in the plugin settings rather than inside the vault itself so that these configuration values are not mixed into my notes.
8. As a Vault Owner, I want the plugin to validate the server URL and vault ID before initiating the device-code flow so that I get a clear error message rather than a cryptic failure.
9. As a Vault Owner, I want the plugin to notify me with an Obsidian notice when the device-code request expires so that I know to retry the connection.
10. As a Vault Owner, I want the plugin to notify me if my device credentials are revoked on the server so that I know to reconnect.

### First-connection sync (seeding and reconcile)
11. As a Vault Owner, I want the plugin to seed an empty Web Vault from my Local Vault on first connection so that my existing notes are immediately available in the browser.
12. As a Vault Owner, I want to see progress notices during seeding so that I know roughly how far along the upload is.
13. As a Vault Owner, I want the plugin to call the seed-complete endpoint after uploading all files so that the initial state is sealed in Artifacts and visible in the sealed history.
14. As a Vault Owner, I want the plugin to pull all Web Vault files into an empty Local Vault on first connection so that I can start using Obsidian on a new device without setting up anything manually.
15. As a Vault Owner, I want the plugin to perform a full reconcile when both the Local Vault and the Web Vault already contain files on first connection so that no data is lost on either side.
16. As a Vault Owner, I want conflicting files discovered during the initial reconcile to be resolved with the same three-way merge the server uses so that safe merges are automatic and unsafe ones become Conflict Notes.
17. As a Vault Owner, I want Vault Internals (`.obsidian/`) to be excluded from reconcile and seeding by default so that another device's Obsidian configuration is not overwritten on my machine.
18. As a Vault Owner, I want to opt into receiving Vault Internals from the Web Vault via a settings toggle so that I can optionally keep my Obsidian configuration in sync across devices.
19. As a Vault Owner, I want OS junk files (`.DS_Store`, `Thumbs.db`, `._*`, etc.) to be silently ignored during seeding and sync so that they never clutter the Web Vault.

### Online two-way sync
20. As a Vault Owner, I want every note I save in Obsidian to appear in the Web Vault within a few seconds so that my most recent work is always accessible from a browser.
21. As a Vault Owner, I want text file changes to be sent as unified diffs rather than whole uploads so that sync is efficient on slow connections.
22. As a Vault Owner, I want binary attachments (images, PDFs, audio) to be uploaded as whole objects so that they arrive intact.
23. As a Vault Owner, I want rename and move operations to be sent explicitly to the server so that the file's history is preserved on the web side.
24. As a Vault Owner, I want deleted local files to be deleted from the Web Vault so that both sides stay in step.
25. As a Vault Owner, I want new files created in the Web Vault to be pulled to my Local Vault automatically so that notes created or edited from the browser appear in Obsidian without any manual action.
26. As a Vault Owner, I want edits made in the Web Vault to be pulled down and applied to local files automatically so that I see the latest version in Obsidian.
27. As a Vault Owner, I want renames and deletes performed in the Web Vault to be reflected in my Local Vault so that the folder structure stays consistent.
28. As a Vault Owner, I want the plugin to debounce rapid saves (e.g. while I am typing) before sending a patch so that a burst of keystrokes does not produce a burst of sync requests.
29. As a Vault Owner, I want the plugin to perform a periodic full-scan fallback (e.g. every 5 minutes) so that any change the watcher missed is caught eventually.
30. As a Vault Owner, I want a manual "Sync now" command that triggers an immediate reconcile so that I can force a full sync at any time.

### Offline journal and reconnect
31. As a Vault Owner, I want the plugin to queue all file changes in an ordered journal while I am offline so that no edits are silently lost.
32. As a Vault Owner, I want the journal to store the base revision number and full content for each pending patch operation so that the server can attempt a three-way merge on replay.
33. As a Vault Owner, I want the journal to be replayed in order via the batch endpoint when I reconnect so that operations are applied with the correct causality.
34. As a Vault Owner, I want clean server merges during replay to be accepted silently so that reconnect is unobtrusive.
35. As a Vault Owner, I want unresolvable merges during replay to create Conflict Notes rather than overwrite my edits so that I never lose work.
36. As a Vault Owner, I want the plugin to refresh from the full server manifest after batch replay so that any remote changes made while I was offline are pulled down.
37. As a Vault Owner, I want the plugin to detect a corrupt or version-mismatched journal and fall back to a full manifest reconcile rather than crashing so that a bad journal state is self-healing.
38. As a Vault Owner, I want the journal to be updated after each accepted sync op so that a mid-sync crash does not replay already-accepted operations.

### Live notifications
39. As a Vault Owner, I want the plugin to open a WebSocket to the server's notify endpoint so that I receive near-instant notification when a file changes in the Web Vault.
40. As a Vault Owner, I want the plugin to re-fetch only the changed file when a notification arrives rather than re-downloading the whole manifest so that notifications are lightweight.
41. As a Vault Owner, I want the plugin to skip pulling a file when the notification's revision matches the revision the plugin already has (echo suppression) so that the plugin's own pushes don't trigger a redundant pull.
42. As a Vault Owner, I want the WebSocket to reconnect with exponential backoff after dropping so that a brief network interruption self-heals without manual intervention.
43. As a Vault Owner, I want the plugin to diff the full manifest on reconnect so that any changes missed while the socket was down are caught.

### Conflict notes
44. As a Vault Owner, I want Conflict Notes created by the server to appear in my Local Vault under `.sync-conflicts/` automatically so that I can inspect and resolve them inside Obsidian.
45. As a Vault Owner, I want the status bar to show a count of unresolved Conflict Notes so that I notice them without having to browse for them.
46. As a Vault Owner, I want a command that opens the `.sync-conflicts/` folder in the Obsidian file explorer so that I can navigate to conflicts quickly.
47. As a Vault Owner, I want resolve actions in the plugin (keep server, keep mine, open for manual merge) so that I do not rely only on deleting notes by hand.
48. As a Vault Owner, I want a resolved Conflict Note deleted automatically (and the status-bar count to drop) so that the conflicts folder stays clean.

### Vault Internals
49. As a Vault Owner, I want the `receiveInternals` opt-in to be stored per-device on the server so that different devices can have different Vault Internals policies without affecting each other.
50. As a Vault Owner, I want the plugin to notify the server of the `receiveInternals` setting when connecting or changing the toggle so that the server-side device record stays in sync.
51. As a Vault Owner, I want the plugin to write received Vault Internals files to the local `.obsidian/` directory via the vault adapter so that the Obsidian configuration is updated correctly.

## Implementation Decisions

Related plan: [`../proposals/sqlite-text-and-conflict-ux.md`](../proposals/sqlite-text-and-conflict-ux.md) (conflict UX after web; `Device.resolveConflict` must be real).

### Package
- New `plugin/` package inside the existing pnpm workspace. Manages its own `package.json`, `esbuild.config.mjs`, `tsconfig.json`, and `manifest.json`.
- Bundled via esbuild into `main.js` (CJS, `es2021`). `obsidian`, `electron`, all `@codemirror/*` packages, and Node builtins are marked external.
- `isDesktopOnly: true` for v1. Mobile deferred to a later slice.
- Plugin ID: `lapis-sync`.

### Settings and persistence
- `LapisSettings { serverUrl, vaultId, syncToken, deviceName, receiveInternals, lastConnectedAt }` persisted via `this.loadData() / this.saveData()`.
- The sync journal (`SyncJournal`) is also stored in `data.json` alongside settings (keyed separately) to avoid a second I/O file. Loaded once on `onload`, written after every journal mutation.

### HTTP transport
- All sync HTTP calls made via `requestUrl` (bypasses CORS, no browser same-origin restriction). Authorization header: `Bearer <syncToken>`. Base URL from `settings.serverUrl`.
- A thin `LapisClient` class wraps `requestUrl` with typed methods for each sync endpoint. The sync engine only depends on a `SyncClientInterface` so unit tests can inject a mock without loading the Obsidian runtime.

### WebSocket notifications
- `new WebSocket(url)` with `Authorization` supplied as a query parameter (`?token=<syncToken>`) since the WebSocket API does not support custom headers. Server side extracts this from the query string when the browser WebSocket spec prohibits custom headers.
- Reconnect with exponential backoff (1 s → 2 → 4 → … → 30 s cap). Missed changes recovered via manifest diff on reconnect.

### Vault event watcher
- `vault.on('create' | 'modify' | 'delete' | 'rename')` registered via `this.registerEvent()`.
- Modify events debounced per-path (500 ms) to avoid mid-save partial content.
- All events filtered through client-side mirrors of `isVaultInternal`, `isOsJunk`, and `isValidVaultPath` before generating ops.
- Vault Internals events only queued if `receiveInternals` is on and only for the direction from server → local (internals are never pushed by the plugin).

### Diff and patch
- Client-side `createPatch(original, modified)` mirrors the LCS-based encoder in the server's `patch.ts`. Produces minimal unified diff. Sent with `baseRevision` and `clientContent` so the server can attempt a three-way merge on stale patches.
- Binary detection: if `vault.readBinary` returns an ArrayBuffer whose content is not valid UTF-8 (or the file extension is a known binary type: `png jpg jpeg gif webp svg pdf mp3 mp4 wav ogg zip`), use whole-object PUT.

### Journal
- `SyncJournal` shape mirrors `worker/src/sync/journal.ts`. Canonical fields: `version:1`, `vaultId`, `lastSyncAt`, `fileRevisions: Record<lcPath, number>`, `fileHashes: Record<lcPath, hexSHA256>`, `pendingOps: PendingOp[]`.
- Revision bookkeeping: after every accepted push or pull, update `fileRevisions[lcPath]` to the server's returned revision. Hashes updated for every write.
- Offline appends are idempotent-safe: if the plugin crashes mid-replay, ops that were already accepted will produce a 409/staleness response; the engine will handle this as a merge attempt rather than a fatal error.

### Reconcile on first connect
- Fetch server manifest. For each path in the union of local files and server files:
  - Server only → pull to local.
  - Local only → push to server (if not Vault Internal or OS junk).
  - Both, identical hash → no-op; record revision.
  - Both, different content → send as a patch with `clientContent` + `baseContent` (empty string as base, since no shared history). Server performs a 3-way merge; unsafe merges produce a Conflict Note.

### Testability boundary
- `SyncEngine` constructor accepts a `SyncClientInterface` (typed mock) and a `VaultAdapter` interface (thin wrapper over the Obsidian `DataAdapter`). This means the engine module is testable without any Obsidian runtime.

## Testing Decisions

Good tests verify observable sync outcomes, not internal state transitions. The relevant seams are:
- **`diff.ts`** — given original and modified strings, produces a valid unified diff; round-trips through `applyPatch` (mirrors tests in `worker/src/vault/patch.ts`).
- **`paths.ts`** — client-side path classification agrees with server-side rules for a table of known-good and known-bad paths.
- **`journal.ts`** — journal survives a save/load round-trip; ops are appended and replayed in order; a corrupt payload triggers a reset rather than a throw.
- **`engine.ts`** — given a fixture vault state and server manifest, reconcile produces the correct set of ops; push outcomes (accepted / merged / conflict) are reflected correctly in journal revisions. Uses a mock `SyncClientInterface` and `VaultAdapter`; no Obsidian import.
- **`device-auth.ts`** — poll loop resolves on `approved`, rejects cleanly on `denied` and `expired`. Uses a mock `requestUrl`.

Prior art in this codebase: the worker's `worker/src/vault/patch.ts` and `worker/src/sync/journal.ts` have the types this module mirrors; use those as the fixture source.

## Out of Scope

- Mobile support (iOS / Android) — deferred; `isDesktopOnly: true` for v1.
- Real-time collaborative editing (CRDTs, OT).
- Running or hosting Obsidian community plugins from the Web Vault.
- Syncing `.obsidian/` by default (opt-in only, per device).
- Multi-vault support within a single plugin instance.
- Sync between two Local Vaults without going through the Web Vault.
- Plugin-side Markdown rendering or preview.
- End-to-end encryption of vault content in transit (auth-gated without E2EE, per ADR 0005).
- Publishing or sharing notes from the plugin.
- Billing, quotas, or usage enforcement.

## Further Notes

The server protocol is fully implemented and tested. All sync endpoints, the device-code flow, the batch journal replay, the three-way merge, and Conflict Note creation are live in `worker/src/`. The plugin is purely a new client — no server changes are required for slices 15–20. The one exception is the WebSocket auth mechanism: the current notify endpoint accepts a `?identity=` query parameter, and the plugin will use `?token=<syncToken>` instead, which requires a one-line addition to the server's notify route to validate Bearer from query string. This is a small server patch, not a new slice.
