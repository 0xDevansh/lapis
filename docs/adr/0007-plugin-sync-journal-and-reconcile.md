# ADR 0007 — Plugin sync journal and first-connect reconcile

**Status:** Accepted — current (revision/patch sync; not Yjs).

## Status
Accepted

## Context

The Obsidian plugin needs to handle three situations that the server-side implementation does not address:

1. **Offline editing** — the user edits notes while the device has no network access. Changes must not be lost and must be applied in the correct order when connectivity returns.

2. **First-connect reconcile** — when both a Local Vault and the Web Vault already contain files at the moment of the first connection, neither side is clearly authoritative. Simply overwriting one side with the other risks data loss.

3. **Testability** — the sync engine runs inside an Obsidian plugin, which makes it hard to unit-test if it depends directly on the Obsidian runtime.

## Decision

### Client-side sync journal

The plugin maintains a `SyncJournal` persisted in the plugin's `data.json` (via `loadData / saveData`). Its shape is intentionally identical to the canonical type in `worker/src/sync/journal.ts`:

```ts
interface SyncJournal {
  version: 1;
  vaultId: string;
  lastSyncAt: string;           // ISO-8601
  fileRevisions: Record<string, number>; // keyed by lowercased path
  fileHashes: Record<string, string>;    // keyed by lowercased path, hex SHA-256
  pendingOps: PendingOp[];
}
```

**Lifecycle:**
- Populated from the server manifest after the first successful sync.
- Initial seeding sets an optional `initialSeedPending` marker before the first upload and clears it only after `seed/complete`; interrupted seeds therefore resume and still produce their initial seal.
- Updated after every accepted push or pull (`fileRevisions`, `fileHashes`, `lastSyncAt`).
- Offline: changes are appended to `pendingOps` in order instead of being sent immediately.
- On reconnect: `pendingOps` are replayed via `POST /batch` (ordered, single DO queue), then the journal is refreshed from the full server manifest to catch any remote changes made while offline.
- If the journal is missing, version-mismatched, or throws on JSON.parse, the plugin drops it and performs a full manifest reconcile as a safe fallback.

**Why `data.json` instead of a separate file:** Obsidian's `loadData / saveData` are the safest persistence primitives available to plugins; a separate file would require direct adapter I/O with no atomic-write guarantees.

### First-connect reconcile via normal merge

When both sides have content on first connection, the plugin treats every differing file as a sync operation:

- **Server only** → pull to local.
- **Local only** → push to server (Vault Content only; Vault Internals and OS junk skipped).
- **Both, identical hash** → no-op; record revision.
- **Both, different content** → send the local content with the journal's last known revision. If no cursor exists, send the `-1` no-shared-base sentinel, which the server interprets as an empty merge base. The server performs a three-way merge; clean merges are returned and applied locally, while unsafe merges create Conflict Notes under `.sync-conflicts/`.

This avoids any "who wins" prompt and produces the same observable behavior as the online three-way merge path, keeping the conflict model consistent across all sync scenarios.

### Injected interface boundary for testability

The `SyncEngine` class takes two injected interfaces:

```ts
interface SyncClientInterface { /* typed methods for each sync endpoint */ }
interface VaultAdapter { read, readBinary, write, writeBinary, list, stat, exists }
```

Neither interface imports `obsidian`. This means the engine module is unit-testable with plain TypeScript mocks, without spinning up an Obsidian instance or using `jest-mock-obsidian`. The `Plugin` subclass is the only code that wires up the concrete Obsidian implementations.

## Alternatives considered

### Local SQLite / separate JSON file for the journal
Would allow more efficient partial updates but requires direct adapter I/O and introduces a second file that can go out of sync with settings. `data.json` is simpler and sufficient given journal sizes (rarely more than a few hundred ops).

### "Choose a side" prompt on first connect
Prompting the user to decide which side wins removes the need for three-way merge logic at connect time, but it risks data loss, puts cognitive load on the user, and is inconsistent with the online sync model that always attempts a merge first. Rejected in favour of the full reconcile.

### Separate journal file outside the vault
Storing the journal outside the vault (e.g. in `~/.config/lapis/`) would prevent the journal from interfering with vault content, but it would break portability (multiple vaults, multiple users on one machine) and would require Node file-system APIs that are not available on mobile. `data.json` inside the plugin directory is the correct Obsidian-idiomatic location.
