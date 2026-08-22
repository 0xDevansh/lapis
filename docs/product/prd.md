# Lapis PRD

For how sync works today: [`../architecture.md`](../architecture.md).  
Accepted next work (DO SQLite text + conflict UX): [`../proposals/sqlite-text-and-conflict-ux.md`](../proposals/sqlite-text-and-conflict-ux.md).

## Problem Statement

Obsidian users can already choose from many sync and backup tools, but those tools generally assume Obsidian is installed wherever the vault needs to be used. A Vault Owner who is away from their primary devices needs private browser access to their Obsidian vault: browse notes, follow wikilinks, search content, inspect backlinks, make light edits, and recover from mistakes without installing Obsidian.

Lapis must make a Web Vault feel like a useful first-class product, while local sync and versioned backups support that experience. The first slice optimizes for a solo Vault Owner, not teams, public publishing, or realtime collaborative editing.

## Solution

Lapis is an open-source, self-deployable Cloudflare application that provides an auth-gated Web Vault. A Durable Object per vault serializes sync (revision + patch for text, whole-object for binaries). **Today** latest content is mirrored to R2; **target** ([ADR 0010](../adr/0010-do-sqlite-text-and-conflict-resolve.md)) stores text in DO SQLite and keeps only binaries on R2. Artifacts (or optional GitHub) hold sealed history; D1 provides FTS. A companion Obsidian plugin connects via device-code and syncs with patches, server-side three-way merge, live notifications, and Conflict Notes with an explicit resolve flow (in progress).

The Web Vault supports browsing, Markdown source editing, rendered preview, folder navigation, backlinks, full wikilink handling, tags, attachments, basic mobile editing, and file operations over Vault Content. Vault Internals such as `.obsidian` are hidden from the normal web experience; each Local Vault can opt into receiving internals updates.

## User Stories

1. As a Vault Owner, I want to open my Web Vault from any browser, so that I can access my notes without installing Obsidian.
2. As a Vault Owner, I want my Web Vault to be private and auth-gated, so that only I can access my vault.
3. As a Vault Owner, I want to create an empty Web Vault, so that I can start using Lapis before connecting Obsidian.
4. As a Vault Owner, I want to seed a Web Vault from an existing Local Vault, so that my current Obsidian notes become available online.
5. As a Vault Owner, I want to connect a Local Vault to exactly one Web Vault, so that sync relationships stay clear.
6. As a Vault Owner, I want multiple Local Vaults/devices connected to the same Web Vault, so that my devices stay in sync.
7. As a Vault Owner, I want a clear device-code connection flow, so that plugin setup does not require copying long secrets.
8. As a Vault Owner, I want to revoke individual device connections, so that lost or retired devices stop syncing.
9. As a Vault Owner, I want to see connected devices, so that I understand which Local Vaults are attached.
10. As a Vault Owner, I want a folder tree, so that I can navigate my vault by path.
11. As a Vault Owner, I want to open Markdown notes in a browser, so that I can read my vault content anywhere.
12. As a Vault Owner, I want Obsidian-style Markdown rendering for core syntax, so that notes look familiar.
13. As a Vault Owner, I want full wikilink support including aliases, so that note links behave like Obsidian links.
14. As a Vault Owner, I want broken wikilinks to be visually distinct with a hover tooltip, so that I know when a linked note does not exist.
15. As a Vault Owner, I want a create-note action for broken links, so that I can quickly fill missing notes.
16. As a Vault Owner, I want backlinks computed from wikilinks, so that I can see which notes reference the current note.
17. As a Vault Owner, I want tags extracted from Markdown and frontmatter, so that I can navigate tagged content.
18. As a Vault Owner, I want built-in themes, so that the Web Vault has comfortable reading styles.
19. As a Vault Owner, I want images and common attachments to render or open, so that notes with assets remain useful.
20. As a Vault Owner, I want a Markdown source editor, so that I can edit notes from the browser.
21. As a Vault Owner, I want rendered preview/read mode by default, so that the browser experience starts as reading, not editing.
22. As a Vault Owner, I want light mobile editing, so that I can make small fixes from a phone or tablet.
23. As a Vault Owner, I want to create Markdown notes in the Web Vault, so that I can capture information without Obsidian.
24. As a Vault Owner, I want to upload attachments in the Web Vault, so that browser-created notes can include files.
25. As a Vault Owner, I want to rename, move, and delete Vault Content, so that I can manage my vault structure online.
26. As a Vault Owner, I want deletes to sync and remain recoverable, so that mistakes are not permanent.
27. As a Vault Owner, I want `.obsidian` and other Vault Internals hidden from normal web browsing, so that noisy device state does not clutter the product.
28. As a Vault Owner, I want each Local Vault to choose whether it receives Vault Internals updates, so that device-specific Obsidian setup remains under my control.
29. As a Vault Owner, I want OS junk and cache files ignored, so that sync focuses on useful vault data.
30. As a Vault Owner, I want simple filename and content search, so that I can find notes quickly.
31. As a Vault Owner, I want search results with path and snippet context, so that I can choose the right result.
32. As a Vault Owner, I want changes made in the Web Vault to appear quickly in connected Local Vaults, so that devices feel current.
33. As a Vault Owner, I want changes made in Obsidian to appear quickly in the Web Vault, so that the browser reflects my real vault.
34. As a Vault Owner, I want connected clients notified of accepted changes in about a second under normal conditions, so that sync feels immediate.
35. As a Vault Owner, I want WebSocket reconnects to recover missed changes by diffing against the manifest, so that temporary disconnections do not corrupt state.
36. As a Vault Owner, I want offline Obsidian edits to sync later, so that my Local Vault remains usable without internet.
37. As a Vault Owner, I want the plugin to keep a lightweight sync journal, so that offline changes can be replayed safely.
38. As a Vault Owner, I want the plugin to fall back to a full scan if its journal is invalid, so that sync can recover from local failures.
39. As a Vault Owner, I want filesystem watcher sync plus periodic scan fallback, so that local changes are detected reliably.
40. As a Vault Owner, I want only text patches sent for text-like files, so that sync payloads stay small.
41. As a Vault Owner, I want binary attachments transferred as whole objects, so that attachment sync remains simple and reliable.
42. As a Vault Owner, I want the server to apply patches into whole-file revisions, so that sync avoids realtime collaborative text complexity.
43. As a Vault Owner, I want server-side three-way merge for stale text patches, so that compatible edits can merge without user work.
44. As a Vault Owner, I want unsafe concurrent edits to create Conflict Notes, so that no change silently overwrites another.
45. As a Vault Owner, I want Conflict Notes under `.sync-conflicts/`, so that conflicts are visible in both Obsidian and the Web Vault.
46. As a Vault Owner, I want Conflict Notes to include server, client, and base versions, so that I have enough context to resolve manually.
47. As a Vault Owner, I want to resolve a conflict from the Web Vault or plugin with clear actions (keep server, keep mine, or manual merge), so that I do not have to edit raw Conflict Notes by hand.
48. As a Vault Owner, I want a resolved Conflict Note to be deleted automatically, so that the conflicts folder stays clean.
49. As a Vault Owner, I want lightweight presence for active sessions/devices, so that I understand where my vault is open.
50. As a Vault Owner, I want a warning when two sessions are on the same file, so that I can avoid avoidable conflicts.
51. As a Vault Owner, I want no editing locks, so that I can keep working even if another session is open.
52. As a Vault Owner, I want every sealed version stored as a Git commit in Artifacts, so that my vault has durable version history.
53. As a Vault Owner, I want live Web Vault changes to sync before they are sealed, so that the product feels responsive.
54. As a Vault Owner, I want live revisions sealed after a short debounce, so that history remains useful without every tiny edit becoming a commit.
55. As a Vault Owner, I want a vault-level timeline of sealed commits, so that I can understand historical changes.
56. As a Vault Owner, I want whole-vault restore from an older commit, so that I can recover from large mistakes.
57. As a Vault Owner, I want per-file restore to create a new commit with older file content, so that restore remains append-only.
58. As a Vault Owner, I want note browsing/editing to stay fast without rewriting every Markdown file to object storage on each save (text in DO SQLite per ADR 0010; binaries on R2).
59. As a Vault Owner, I want Artifacts tokens hidden from normal clients, so that clients cannot bypass the product sync API.
60. As a self-hosting operator, I want Lapis deployable to a single Cloudflare account, so that I can run my own instance.
61. As a self-hosting operator, I want clear setup docs for Workers, Durable Objects, R2, Artifacts, and D1, so that deployment is reproducible.
62. As a self-hosting operator, I want no built-in billing or product quotas, so that my instance is governed by my Cloudflare limits and optional config.
63. As a self-hosting operator, I want optional upload/storage limits in configuration, so that I can protect my own deployment.
64. As a self-hosting operator, I want to export the latest vault as a zip, so that I can leave or back up outside Lapis.

## Implementation Decisions

- Lapis is web-first. Sync and backups support the Web Vault, but the product is not positioned as a generic sync tool.
- The first product slice is for a solo Vault Owner. Teams, collaboration, and public publishing are out of scope.
- The first slice supports private Web Vault access, Markdown editing, backlinks, folder navigation, search, file operations, attachments, built-in themes, and light mobile editing.
- Core Rendering covers Markdown, wikilinks, embeds for images/attachments, backlinks, tags, frontmatter, common callouts, and built-in themes. It excludes community plugin execution and Obsidian plugin runtime emulation.
- Vault Content is visible and manageable in the Web Vault. Vault Internals are hidden from normal web browsing and handled through sync preferences.
- Each Vault Owner can have multiple Web Vaults. One Local Vault connects to exactly one Web Vault. Multiple Local Vaults can connect to one Web Vault.
- First-time setup can start from a plugin-seeded Local Vault or an empty Web Vault. Syncing an existing Web Vault into a non-empty unrelated local folder is not allowed by default.
- The Durable Object is authority for live vault mutations. **Today** text and binaries are mirrored to R2. **Target** ([ADR 0010](../adr/0010-do-sqlite-text-and-conflict-resolve.md)): text latest in DO SQLite; binaries on R2; Artifacts/GitHub for sealed history; D1 FTS for search.
- Accepted changes update the DO head immediately, notify peers, and are sealed into Artifacts/GitHub on a longer debounce.
- Server-created commits are the normal path. Clients and plugins do not push directly to Artifacts and do not receive Artifacts repo tokens.
- Text-like files use file-diff patches for transport. The server materializes accepted patches into file revisions. Binary files use whole-object transfers.
- Server-side three-way merge is attempted for stale text patches. Unsafe conflicts create Conflict Notes rather than last-writer-wins overwrites.
- Conflict Notes are Markdown under `.sync-conflicts/` while open. Primary resolve path is keep-server / keep-mine / manual-merge, which **deletes** the note (hand-deleting the note remains a fallback).
- Search indexes Vault Content only and updates on accepted revisions.
- Backlinks are computed server-side from wikilinks in latest Vault Content.
- Auth uses better-auth for normal web login and device-code plugin connection if supported; otherwise Lapis implements a compatible device-code flow.
- There is no end-to-end encryption in the first slice. Vault access is auth-gated and private to the deployment.
- Restore creates new commits rather than moving Git heads backward.
- Lapis is open source and self-deployable to Cloudflare. It has no built-in pricing or hard product quotas, though deployment config may define optional limits.

## Testing Decisions

- Test external behavior at product seams: sync API, Web Vault reads, plugin connection flows, search results, conflict creation/resolve, restore behavior, and storage projection consistency (R2 binaries; DO SQLite text after ADR 0010).
- Sync tests should verify observable state transitions: accepted patch updates head storage, emits notifications, updates search/backlinks, and eventually seals a commit.
- Conflict tests should use base/local/remote fixtures and assert either clean merge or Conflict Note creation with full context.
- Offline plugin tests should verify journal replay, stale patch merge, fallback full scan, and reconnect manifest diff recovery.
- Rendering tests should use representative Markdown fixtures for wikilinks, aliases, broken links, tags, frontmatter, callouts, and attachments.
- Restore tests should verify restore creates a new current commit and syncs as an ordinary change.
- Auth tests should cover web session authorization, device-code connection, device revocation, and denial of direct Artifacts token exposure.

## Out of Scope

- Teams and multi-user collaboration.
- Public Published Pages.
- Realtime collaborative text editing, cursors, CRDTs, or operational transform.
- Obsidian community plugin execution or plugin API emulation.
- Canvas editing and Properties UI.
- End-to-end encryption.
- Billing, pricing, or hosted SaaS quota enforcement.
- Zip/Git import in the first slice, beyond plugin seeding and empty Web Vault creation.
- Semantic/vector search.
- Binary delta sync.

## Further Notes

- Artifacts is currently closed beta and has a documented 10 GB per-repository limit and 1 TB per-account default limit. Lapis should surface deployment prerequisites clearly.
- R2 is the latest-file read model, not the version-history source.
- Artifacts is the sealed version-history source, not the fast file-serving API.
- The product should avoid saying it renders “exactly like Obsidian” without narrowing that claim to Core Rendering.
