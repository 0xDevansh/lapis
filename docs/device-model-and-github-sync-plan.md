# Plan: Unified Device Model + GitHub Sync (Slices 21–26)

This is the master plan for three linked initiatives from the architecture review:

1. A general **Device** abstraction (Plugin / Web / Agent / GitHub all derive from it).
2. Replacing **Artifacts** with real **GitHub** push/pull integration.
3. Correctness fixes surfaced by the high-frequency-edit analysis (identity drift,
   plugin sync races, and the dormant three-way-merge / Conflict Note code).

Composer should execute the slices **in order** — each is independently shippable and
unblocks the next. Do not start a later slice before its `Blocked by` slices are green.

## Why this order

- Slices 21–22 are **foundational correctness** work that everything else depends on:
  a single canonical identity string, a race-free plugin sync loop, and the
  already-written-but-unwired `merge3()` / Conflict Note machinery actually being called.
- Slice 23 introduces the `Device` interface and retrofits the two existing clients
  behind it **without changing behavior** — a pure refactor with tests as the safety net.
- Slice 24 makes agents first-class writers (their own device row, token, author,
  conflict policy) by reusing the Slice 23 plumbing.
- Slices 25–26 model **GitHub as a Device** (`transport: "git"`), reusing the merge
  engine from Slice 22 and the device plumbing from Slice 23. Artifacts is retired last,
  behind the same interface, so history/snapshots keep working throughout.

## Architectural invariants (must hold across all slices)

- The one-per-vault `VaultCoordinator` Durable Object remains the single serialization
  point for all vault mutations. Devices never write R2 or D1 FTS directly.
- Secrets (Artifacts tokens, GitHub PATs) are **server-only**. They are never returned
  to web/plugin/agent clients in any API response.
- Author attribution is always the canonical form `${kind}:${id}` (Slice 21).
- Every mutation still produces exactly one `ChangeNotification` broadcast so all
  connected peers converge.
- No slice may lose data on conflict: unresolved conflicts become Conflict Notes,
  never silent overwrites.

## Slice index

| Slice | Title | Blocked by |
|------|-------|-----------|
| 21 | Canonical Device Identity + Plugin Sync Concurrency Fix | 10, 17 |
| 22 | Server-Side Three-Way Merge & Conflict Notes (complete Slice 11) | 09, 21 |
| 23 | Unified Device Model (interface + generalized `devices` table) | 21, 22 |
| 24 | First-Class Agent Devices | 23 |
| 25 | GitHub Remote — PAT Storage + Outbound Push | 04, 23 |
| 26 | GitHub Bidirectional Sync + Conflict Resolution (retire Artifacts) | 22, 25 |

## Global definition of done

- `pnpm -r typecheck` and `pnpm -r test` pass (worker, web, plugin).
- No PAT/token value appears in any HTTP response body or client-visible log.
- Manual end-to-end smoke: edit same file from plugin + web + GitHub concurrently and
  confirm convergence with a Conflict Note when (and only when) merge is unsafe.
