# 23. Unified Device Model

## What to build

Introduce a general `Device` abstraction that defines how any peer sends edits, receives
edits, tracks a sync cursor, resolves conflicts, and reports presence. Generalize the
`devices` table to describe any peer kind, and retrofit the existing Plugin and Web clients
behind the interface **without changing their observable behavior**.

## Why

Identity and sync logic are currently bespoke per client. A single interface lets Agents
(Slice 24) and GitHub (Slices 25–26) be added as peers by implementing one contract instead
of special-casing each. The server DO remains the hub; `Device` formalizes the peers.

## Acceptance criteria

- [ ] A `Device` interface exists with: `identity`, `capabilities`, `conflictPolicy`,
      `sendEdit`, `receiveEdit`, `resolveConflict`, `getCursor`/`setCursor`, `reportPresence`.
- [ ] The `devices` table has `kind`, `capabilities` (JSON), `conflict_policy`, and
      `sync_cursor` columns; existing rows migrate to `kind='plugin'` with today's defaults.
- [ ] `PluginDevice` implements the interface and the plugin uses it; behavior (5s debounce,
      GET+POST patch, offline journal, client rebase) is unchanged and all plugin tests pass.
- [ ] `WebDevice` implements the interface and the web app uses it; manual-save,
      incremental-patch-receive, and dirty-tab protection are unchanged and web tests pass.
- [ ] Cursor abstraction: per-file integer revision for REST devices, opaque string for git
      devices (populated in Slice 25/26). REST devices ignore the string form.
- [ ] Server can list peers of a vault with kind + capabilities for the devices UI.
- [ ] No behavioral regressions; this slice is a refactor validated by existing tests plus
      the new contract tests below.

## Blocked by

- 21. Canonical Device Identity And Plugin Sync Concurrency
- 22. Server-Side Three-Way Merge And Conflict Notes (Wired)

## Implementation notes

### Shared contract (worker + clients)
Define the interface in a place all three packages can import (e.g. a small shared types
module, or duplicate the TS interface per package if there is no shared package yet — match
whatever the repo already does for `ManifestEntry`/`ChangeNotification`).

```typescript
type DeviceKind = "plugin" | "web" | "agent" | "github";
type ConflictPolicy = "rebase" | "merge3" | "conflict-note" | "pr";

interface DeviceIdentity { id: string; kind: DeviceKind; displayName: string; author: string; }
interface DeviceCapabilities {
  bidirectional: boolean; realtime: boolean; offlineQueue: boolean;
  receiveInternals: boolean; transport: "rest" | "git";
}
interface EditOp {
  kind: "put" | "patch" | "rename" | "delete";
  path: string; baseRevision?: number; patch?: string;
  content?: Uint8Array; newPath?: string;
}
interface Device {
  readonly identity: DeviceIdentity;
  readonly capabilities: DeviceCapabilities;
  readonly conflictPolicy: ConflictPolicy;
  sendEdit(op: EditOp): Promise<SendResult>;
  receiveEdit(change: ChangeNotification): Promise<void>;
  resolveConflict(ctx: ConflictContext): Promise<Resolution>;
  getCursor(path: string): number | string | null;
  setCursor(path: string, cursor: number | string): Promise<void>;
  reportPresence(openPath: string | null): void;
}
```

### Server data model
- New migration `worker/migrations/0009_device_model.sql` (use next free number):
  ```sql
  ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'plugin';
  ALTER TABLE devices ADD COLUMN capabilities TEXT;      -- JSON
  ALTER TABLE devices ADD COLUMN conflict_policy TEXT NOT NULL DEFAULT 'rebase';
  ALTER TABLE devices ADD COLUMN sync_cursor TEXT;       -- git commit SHA for git peers
  ```
- `worker/src/devices/` : add a `DeviceRecord` type + query helpers (get/list/upsert with
  the new columns). The `requireDevice` middleware should surface `kind`/`capabilities`.

### PluginDevice (`plugin/src/device/plugin-device.ts`, new)
- Wrap the existing `SyncEngine`: `sendEdit` maps to `pushPut`/`pushRename`/`pushDelete`,
  `receiveEdit` maps to `applyRemotePut`/`applyRemoteRename`/`applyRemoteDelete`,
  `resolveConflict` uses `applyTextPatchWithRebase`, cursor = journal `fileRevisions`,
  offline queue = `pendingOps`. `main.ts` calls the device, still through the Slice 21 mutex.

### WebDevice (`web/src/device/web-device.ts`, new)
- `sendEdit` = `putTextFile` on save, `receiveEdit` = the incremental patch apply in
  `VaultWorkspace.tsx`, cursor = per-tab `baseRevision`, `offlineQueue: false`,
  `resolveConflict` = refetch + retry.

### Tests
- Contract test suite parameterized over device implementations: given a sequence of
  local + remote edits, each device converges to the same head. Run it against
  `PluginDevice` and `WebDevice` (and later Agent/GitHub) to prove the abstraction holds.
