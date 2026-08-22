# 21. Canonical Device Identity And Plugin Sync Concurrency

## What to build

Establish one canonical identity string for every sync peer (`${kind}:${id}`) used
uniformly for authorship, presence, and self-echo filtering, and make the plugin's
sync loop race-free by serializing all journal read-modify-write cycles through a
single-flight queue.

## Why

The review found two latent bugs that get worse under sustained editing:

1. **Identity drift.** The server tags writes `device:{id}` but reports presence as
   `device:{deviceName}`, while the web client uses `web:{sessionId}` / `session:{sessionId}`.
   Self-echo filtering and presence comparison can disagree.
2. **Unsynchronized `runSync`.** `plugin/src/main.ts` `runSync` starts overlapping
   invocations (debounced pushes, the 5-min pull, inbound notify `applyRemotePut`) that
   each read `this.journal`, mutate a copy, and write back — a last-writer-wins race that
   can silently drop `pendingOps` / `fileRevisions`.

## Acceptance criteria

- [ ] A shared `deviceAuthor(kind, id)` helper produces `${kind}:${id}` and is the single
      source of authorship strings across worker, web, and plugin.
- [ ] The server broadcasts presence identity and change `author` using the **same**
      canonical string for a given peer (`device:{id}`, `web:{id}`), not `deviceName`.
- [ ] Plugin self-echo filtering and presence self-filtering both key off the canonical
      `device:{deviceId}` string and agree.
- [ ] All plugin `runSync` invocations execute serially: no two journal read-modify-write
      cycles overlap. A push started while another is in flight waits, it does not race.
- [ ] Inbound notify handling (`applyRemotePut` / rename / delete) participates in the same
      serialization as outbound pushes.
- [ ] Existing sync behavior is otherwise unchanged; all current plugin/web tests pass.

## Blocked by

- 10. Live Notifications And Presence
- 17. Plugin Online Two-Way Sync

## Implementation notes

### Worker
- `worker/src/vault/identity.ts` (new): `export function deviceAuthor(kind: string, id: string)`
  returning `` `${kind}:${id}` ``. Export a `DeviceKind` union (`"plugin" | "web" | "agent" | "github"`).
- `worker/src/notify/routes.ts` and the WebSocket presence path in
  `worker/src/vault/coordinator.ts` (`fetch` `/ws`, `presenceSnapshot`): pass and store the
  **canonical id-based** identity, not `deviceName`. The `identity` query param used in
  `acceptWebSocket` must be `device:{deviceId}` / `web:{sessionId}`.
- `worker/src/sync/routes.ts`: replace the inline `` `device:${device.id}` `` literals with
  `deviceAuthor("plugin", device.id)` (keep the value identical; centralize it).
- `worker/src/vault/routes.ts`: replace `web:${sessionId}` literals with `deviceAuthor("web", sessionId)`.

### Plugin
- `plugin/src/main.ts`:
  - Introduce a promise-chain mutex, e.g. `private syncChain: Promise<void> = Promise.resolve();`
    and route **every** `runSync` call through it: `this.syncChain = this.syncChain.then(() => run()).catch(...)`.
    This guarantees serialized journal access without dropping work.
  - Fix presence self-filtering in `handleNotifyMessage` to compare against
    `device:${this.settings.deviceId}` (align with the change-echo filter already there).
  - Confirm the notify `open`/presence identity sent by `plugin/src/net/notify.ts` is
    `device:{deviceId}`.
- `plugin/src/net/notify.ts`: send canonical identity on connect.

### Web
- `web/src/pages/VaultWorkspace.tsx` / notify hook: ensure the self-echo check compares
  against the canonical `web:{sessionId}` produced by the same helper on the server.

### Tests
- Worker unit test: two concurrent `syncApplyPatch` calls from the same author still both
  broadcast with the canonical author string.
- Plugin test: fire a push and an inbound `applyRemotePut` "simultaneously"; assert the
  journal reflects both (no lost update). A fake timer + resolved-promise interleaving test
  is sufficient.
