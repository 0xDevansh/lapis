# Lapis PRD

## Problem Statement

Obsidian users can already choose from many sync and backup tools, but those tools generally assume Obsidian is installed wherever the vault needs to be used. People need private browser access to an Obsidian vault: browse notes, follow wikilinks, search content, inspect backlinks, make light edits, and recover from mistakes without installing Obsidian — and they need multiple people and devices to work on the same vault without silent overwrites.

Lapis must make a Web Vault feel like a useful first-class product, while local sync and versioned backups support that experience. Collaborative vaults use CRDT-based sync so concurrent edits merge without Conflict Notes.

## Solution

Lapis is an open-source, self-deployable Cloudflare application that provides an auth-gated Web Vault. Each vault is coordinated by a Durable Object that hosts a Yjs `Y.Doc` (text lives in DO SQLite; binaries in R2). Members connect as Yjs peers over WebSocket (browser sessions and Obsidian plugin devices). D1 provides auth, membership, and FTS. Artifacts/Git optionally seal debounced snapshots for history.

The Web Vault supports browsing, Markdown source editing, rendered preview, folder navigation, backlinks, full wikilink handling, tags, attachments, basic mobile editing, and file operations. Vault Internals such as `.obsidian` are hidden from the normal web experience; each Local Vault can opt into receiving internals updates.

## User Stories

### Access and membership
1. As a user, I want to sign up with email/password or Google, so that I can access Lapis quickly.
2. As a Vault Owner, I want to create a Web Vault I own, so that I can start taking notes online.
3. As a Vault Owner, I want to invite others as editors or viewers, so that we can share one vault.
4. As an Editor, I want to read and write vault content, so that I can collaborate.
5. As a Viewer, I want read-only access, so that I can browse without changing notes.
6. As a Vault Owner, I want to change roles or remove members, so that access stays under my control.
7. As a member, I want the vault list to show every vault I belong to and my role, so that shared vaults are discoverable.

### Web vault
8. As a member, I want a folder tree, Markdown editing/preview, wikilinks, backlinks, tags, search, attachments, and light mobile editing.
9. As a Viewer, I want the editor to be read-only.
10. As a member, I want Vault Internals hidden from normal browsing.
11. As a member, I want zip export and restore from sealed history when configured.

### Sync and devices
12. As an Owner or Editor, I want to connect an Obsidian Local Vault via device-code, so that desktop notes stay in sync.
13. As a member with a connected plugin, I want local creates/edits/renames/deletes to sync through Yjs without Conflict Notes for text.
14. As a member, I want offline Obsidian edits to merge cleanly when reconnecting.
15. As a Vault Owner, I want to revoke devices, so that lost machines stop syncing.
16. As a member, I want binary attachments to sync via R2 with last-write-wins.

### Operations
17. As a self-hosting operator, I want Lapis deployable on one Cloudflare account with clear setup docs.
18. As a self-hosting operator, I want optional upload/storage limits and no built-in billing.

## Implementation Decisions

- Lapis is web-first. Sync and backups support the Web Vault.
- Collaborative vaults are in scope: custom `vault_members` with `owner` / `editor` / `viewer` (ADR 0009). better-auth access control statements enforce permissions; the full organization plugin is not used.
- Auth: better-auth email/password + Google OAuth; device-code for plugins.
- Sync: Yjs CRDT over WebSocket; one `Y.Doc` per vault in a Durable Object (ADR 0008).
- Text/markdown lives only in DO SQLite as Yjs state. R2 stores binaries only (LWW).
- Files use stable `fileId`s; path is metadata so rename/move/delete commute with concurrent edits.
- Debounced side effects: D1 FTS/backlinks/tags, optional Git/Artifacts seal, soft-delete and orphan R2 GC.
- No awareness/cursors UI in this slice (clients still sync as Yjs peers).
- No end-to-end encryption.
- Restore creates new sealed commits rather than moving Git heads backward when history is enabled.
- Lapis is open source and self-deployable to Cloudflare.

## Testing Decisions

- Test Yjs sync: concurrent text edits converge; rename+edit commute; soft-delete+offline edit revives.
- Test ACL: viewer cannot write; editor can write; owner can manage members; non-members get 404/403.
- Test Google and email auth sessions.
- Test plugin device pairing, offline reconnect, and filesystem rename/delete echo suppression.
- Test binary LWW and R2 orphan GC after debounce.
- Test migration of legacy R2 text vaults into Yjs.

## Out of Scope

- Live cursors / awareness UI (may land later on the same Yjs substrate).
- better-auth organization plugin / teams-as-workspaces owning many vaults.
- Public Published Pages.
- Obsidian community plugin execution or plugin API emulation.
- Canvas editing and Properties UI.
- End-to-end encryption.
- Billing, pricing, or hosted SaaS quota enforcement.
- Semantic/vector search.
- Binary delta sync inside the CRDT.

## Further Notes

- DO storage size and Yjs compaction are operational concerns for large vaults.
- GitHub bidirectional sync must be redesigned against Yjs; treat as snapshot import/export until redesigned.
- Invite links work without SMTP; email delivery is optional for self-hosters.
