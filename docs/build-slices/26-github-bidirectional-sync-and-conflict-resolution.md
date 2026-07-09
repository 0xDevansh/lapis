# 26. GitHub Bidirectional Sync And Conflict Resolution

## What to build

Complete GitHub integration by adding the inbound direction: fetch commits made on GitHub,
reconcile them into the vault's live state with per-file three-way merge, push the result
back, and model the whole thing as a `GitHubDevice` peer. Retire Artifacts as the default
history store (kept behind the `GitRemote` interface for existing vaults).

## Why

Outbound-only (Slice 25) is one-way. Real integration means edits made directly on GitHub
(web UI, other clones, PRs merged) flow back into the vault and converge with plugin/web/agent
edits. Because Lapis is per-file-revision and git is commit/tree-based, every sync must
translate between the two models and resolve divergence safely using the Slice 22 merge engine.

## Acceptance criteria

- [ ] `GitHubDevice` implements the Slice 23 `Device` interface with `transport: "git"`,
      `bidirectional: true`, cursor = commit SHA (`last_synced_commit`),
      `conflictPolicy` configurable (`"merge3"` default, `"pr"` optional).
- [ ] Inbound sync fetches the branch, computes the file-level diff
      `last_synced_commit..origin/branch`, and for each changed path runs
      `merge3(base, ours, theirs)` where `base` = content at `last_synced_commit`,
      `ours` = current vault head, `theirs` = GitHub content.
- [ ] Resolution matrix is honored:
      only-GitHub-changed → fast-forward into vault (new revision + broadcast);
      only-vault-changed → keep vault (pushed outbound);
      both changed + clean merge → write merged (new revision + broadcast + push back);
      both changed + conflict (text) → apply `conflictPolicy`;
      binary both changed → keep vault version + Conflict Note referencing the GitHub blob.
- [ ] Every inbound-applied change produces a `ChangeNotification` so plugin/web/agent peers
      converge exactly as with a local write. Author is `github:{remoteId}`.
- [ ] Push-race handling: if the post-merge push is rejected (non-fast-forward), re-fetch and
      re-run the merge loop; bounded retries, then fall back to a `lapis/conflict-<ts>` branch.
- [ ] `"pr"` policy: instead of writing markers to the live file, push merged-with-markers to
      a conflict branch and open a PR via the GitHub API.
- [ ] `last_synced_commit` advances to the pushed SHA only after a fully reconciled round trip.
- [ ] Optional GitHub webhook route triggers inbound sync near-real-time; polling fallback on
      the seal interval otherwise.
- [ ] Artifacts is no longer the default for new vaults; existing Artifacts-backed vaults keep
      working through `GitRemote`. Document the migration path.

## Blocked by

- 22. Server-Side Three-Way Merge And Conflict Notes (Wired)
- 25. GitHub Remote — PAT Storage And Outbound Push

## Implementation notes

### The model-translation core (`worker/src/git/reconcile.ts`, new)
- Clone/fetch the branch shallow into `MemoryFS` (reuse the sealer's isomorphic-git setup).
- `theirs` = tree at `origin/branch`; `base` = tree at `last_synced_commit`
  (empty tree if null → first sync treats all GitHub files as additions).
- For each path in the union of {changed in theirs, dirty in vault since last_synced}:
  read the three versions, dispatch through the resolution matrix, and apply vault-side
  changes via the **existing coordinator write path** (so revisions, R2 flush, FTS index,
  broadcast, and re-seal all happen normally). Reuse Slice 22's `writeConflictNote`.
- Respect `subdir`: map git paths ↔ vault paths through the configured prefix.

### GitHubDevice (`worker/src/git/github-device.ts`, new)
- `sendEdit` = batch into commit + push (delegates to Slice 25 outbound).
- `receiveEdit` = run the reconcile loop above.
- `getCursor`/`setCursor` operate on `last_synced_commit` (opaque string cursor from Slice 23).
- Not realtime in the WS sense; presence is a no-op.

### Coordinator / triggering
- Reuse the seal alarm to also drive GitHub sync (pull → merge → push), debounced.
- Add `sync_state` transitions: `idle → pulling → pushing → idle`, or `→ conflict` on
  bounded-retry exhaustion. Expose current state in the git-remote GET route.

### Webhook (optional but recommended)
- `POST /api/webhooks/github/:vaultId` verifying the GitHub signature (shared secret stored
  with the remote), enqueuing an inbound sync on the DO.

### Retiring Artifacts
- Default new vaults to no history store until a GitHub remote is connected, or keep Artifacts
  as an optional `GitRemote` for users who do not want GitHub. Update ADR-0004 with a short
  addendum recording the shift; add ADR "GitHub as version-history remote".
- Snapshots UI is unchanged (it reads through `GitRemote`).

### Tests
- Inbound-only change fast-forwards into the vault and broadcasts.
- Concurrent GitHub + vault edits: disjoint → clean merge + push back; overlapping →
  Conflict Note (merge3 policy) or PR (pr policy).
- Push-race: simulate an intervening remote commit → loop re-merges and succeeds, or falls
  back to a conflict branch after the retry bound.
- Round trip is idempotent: syncing twice with no changes is a no-op and does not advance
  `last_synced_commit` spuriously.
- Slice 23 contract suite passes against `GitHubDevice`.
