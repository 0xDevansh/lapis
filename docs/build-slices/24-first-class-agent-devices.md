# 24. First-Class Agent Devices

## What to build

Promote agents from "read-only clients impersonating the human's session" to first-class
`Device` peers: each agent gets its own device record, its own scoped token, real author
attribution (`agent:{id}`), write access, presence, and a safe default conflict policy.

## Why

`examples/agent-vault-access` authenticates with the vault owner's email/password and only
reads. To treat agents as first-class users, their writes must be attributable, visible in
history and Conflict Notes, present in presence/same-file warnings, and safe by default
(an autonomous writer must never silently clobber a human edit).

## Acceptance criteria

- [ ] An owner can mint an **agent device** for a vault, producing an `AgentDevice` record
      (`kind='agent'`) with its own token, distinct from plugin device-code tokens.
- [ ] Agent writes are attributed as `agent:{id}` in change notifications, Conflict Notes,
      and sealed/committed history.
- [ ] `AgentDevice` implements the Slice 23 `Device` interface with `transport: "rest"`,
      `bidirectional` (can pull), `realtime: false` by default (pull-based), and its own
      `receiveInternals` scoping.
- [ ] Default `conflictPolicy` for agents is `"conflict-note"`: a stale agent write never
      overwrites; it produces a Conflict Note.
- [ ] Agents appear in the vault's device/peer list and (when connected) in presence.
- [ ] `examples/agent-vault-access` is updated to authenticate as an agent device token and
      gains a `vault_write_file` tool routed through the standard sync write path.
- [ ] Agent tokens can be revoked like any device; revocation immediately blocks writes.

## Blocked by

- 23. Unified Device Model

## Implementation notes

### Token issuance
- Add an owner-authenticated route to create an agent device, e.g.
  `POST /api/vaults/:id/agents` → `{ agentId, token, name }` (token shown once).
- Reuse the `devices` table; set `kind='agent'`, `capabilities` JSON, `conflict_policy='conflict-note'`.
- Reuse `requireDevice` for agent write auth (Bearer token). Confirm `device.vaultId` guard
  applies. Consider a distinct auth prefix or scope claim if agent and plugin tokens should
  be visually distinguishable, but they can share the table and middleware.

### Author attribution
- Writes from an agent token call the coordinator with `deviceAuthor("agent", agentId)`
  (Slice 21 helper). No coordinator changes beyond passing the author through — it already
  accepts an `author` param on every mutation method.

### Conflict policy plumbing
- The coordinator's merge logic (Slice 22) already produces Conflict Notes; ensure the
  per-device `conflict_policy` is read and honored. For `"conflict-note"`, a stale agent
  write always yields a note rather than a merge-accept, even when `merge3` would be clean,
  if you want maximum caution — **decision: allow clean merges, force note only on
  `hasConflicts`**, matching human devices, so agents stay useful. Document this choice.

### Example agent (`examples/agent-vault-access`)
- Replace email/password login with `LAPIS_AGENT_TOKEN` + `LAPIS_VAULT_ID`.
- Add `vault_write_file` and `vault_apply_patch` tools that call the `/api/sync/...` device
  endpoints with the agent token. Update the README's "Extending the agent" section, which
  already anticipates this.

### Tests
- Agent write is attributed `agent:{id}` end-to-end (notification + sealed commit author).
- Concurrent human + agent edit to the same lines → Conflict Note; disjoint edits → clean merge.
- Revoked agent token is rejected on write.
- Run the Slice 23 contract suite against `AgentDevice`.
