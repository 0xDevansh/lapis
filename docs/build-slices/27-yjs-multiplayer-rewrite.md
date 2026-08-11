# Yjs Multiplayer Vault Rewrite

## What to build

Replace revision/patch sync with Yjs CRDTs hosted in per-vault Durable Objects. Text lives in DO SQLite only; R2 keeps binaries (LWW). Add multi-user vault membership (`owner` / `editor` / `viewer`) and Google sign-in.

## Acceptance criteria

- [x] ADRs 0008/0009; superseded 0001/0002/0004/0007 notes; PRD/plugin-prd/README updated
- [x] `vault_members` + `vault_invites` migration; ACL helper; members/invite API + UI
- [x] Google OAuth via better-auth `socialProviders.google`
- [x] Y.Doc in VaultCoordinator with stable fileIds; WS `/yjs` for session + device
- [x] Text DO-resident; binary R2 + meta; migration from legacy R2 text
- [x] Debounced compact + FTS reindex
- [x] Web Yjs provider + Google CTA + invite accept page
- [x] Plugin `PluginYjsClient` + **YjsFsBridge**: vault watchers, path↔fileId map, hash-based move detection, startup reconcile, text deltas
- [x] Offline / external edits: on open or Sync now, scan disk, match moves by content hash, apply content deltas into `Y.Text`, delete+create when hash cannot uniquely match
- [x] Optional: delete dead legacy `SyncEngine` / journal modules once confident
- [ ] Bind web editor directly to `Y.Text` (still partly REST)

## Blocked by

- None (greenfield rewrite on existing DO)

## References

- ADR 0008, ADR 0009
- Plan: Yjs Multiplayer Rewrite
