# Lapis Obsidian Plugin PRD

## Problem Statement

A Vault Owner who uses Lapis to access their notes in a browser still has to choose between two disjointed workflows: keep editing in Obsidian on their primary device, or switch to the Web Vault. There is no automatic bridge between them. Changes made in Obsidian are invisible in the Web Vault until the owner manually uploads them, and changes made in the Web Vault (edits, renames, new notes from wikilink creation) never appear locally at all.

The missing piece is a locally-installed companion that watches the Local Vault, pushes changes to the Web Vault as they happen, pulls remote changes down, and keeps both sides coherent even when the device is temporarily offline.

## Solution

An Obsidian community plugin that acts as a sync agent between the Local Vault and the Web Vault. The plugin connects once via a device-code flow (no pasting long secrets), then runs silently in the background: watching for local file changes, patching or uploading them to the server, pulling remote changes down, queuing work offline and replaying it on reconnect, and surfacing any merge conflicts as Conflict Notes inside the vault.

The server already implements the full sync protocol. The plugin is a client that speaks it.

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
47. As a Vault Owner, I want the plugin to remove a Conflict Note from the conflict count in the status bar once I delete it so that resolving a conflict is as simple as deleting the note.

### Vault Internals
48. As a Vault Owner, I want the `receiveInternals` opt-in to be stored per-device on the server so that different devices can have different Vault Internals policies without affecting each other.
49. As a Vault Owner, I want the plugin to notify the server of the `receiveInternals` setting when connecting or changing the toggle so that the server-side device record stays in sync.
50. As a Vault Owner, I want the plugin to write received Vault Internals files to the local `.obsidian/` directory via the vault adapter so that the Obsidian configuration is updated correctly.

## Implementation Decisions

### Package
- `plugin/` package in the pnpm workspace. esbuild → `main.js` (CJS). Plugin ID: `lapis-sync`. `isDesktopOnly: true` for v1.

### Settings and persistence
- `LapisSettings { serverUrl, vaultId, syncToken, deviceName, receiveInternals, lastConnectedAt }` plus local Yjs state blob / path↔fileId map in plugin `data.json`.

### Sync transport
- Primary: device-authenticated Yjs WebSocket (`/api/sync/:vaultId/yjs?token=…`).
- Binary upload helper over HTTP when attaching new binaries to R2, then meta update in the Y.Doc.
- Reconnect with exponential backoff; state-vector sync recovers missed updates.

### Vault event watcher
- `vault.on('create' | 'modify' | 'delete' | 'rename')` with per-path debounce on modify.
- Map events to stable `fileId` ops (rename/delete never recreate `Y.Text` for the same logical file).
- Echo suppression for remote-origin path ops.
- Filter Vault Internals / OS junk like the server path rules.

### Offline
- Persist local Yjs updates; merge on reconnect via CRDT. Queue binary uploads until online.

### Testability
- Sync engine depends on injected vault adapter + Yjs provider interfaces so unit tests avoid the Obsidian runtime.

## Testing Decisions

- Concurrent text edits converge; rename+edit commute; soft-delete+offline edit revives.
- Echo suppression: remote rename does not re-enter the CRDT.
- Device-code poll resolves on approved/denied/expired.
- Path classification matches server rules.

## Out of Scope

- Mobile support (`isDesktopOnly: true` for v1).
- Awareness/cursors inside Obsidian.
- Syncing `.obsidian/` by default (opt-in only).
- Multi-vault in one plugin instance.
- Peer-to-peer Local Vault sync without the Web Vault.
- E2EE; publishing; billing.

## Further Notes

See ADR 0008 (Yjs + DO text) and ADR 0009 (members). Legacy patch/journal/Conflict Note protocol is retired.

