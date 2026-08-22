# Lapis documentation

The repository-root [`README.md`](../README.md) is the product landing page.
This tree is the durable engineering and product documentation.

## What to read when

| If you want… | Read |
|---|---|
| How sync actually works **today** | [`architecture.md`](architecture.md) |
| Next storage + conflict work | [`proposals/sqlite-text-and-conflict-ux.md`](proposals/sqlite-text-and-conflict-ux.md) ([ADR 0010](adr/0010-do-sqlite-text-and-conflict-resolve.md)) |
| Product goals / user stories | [`product/prd.md`](product/prd.md), [`product/plugin-prd.md`](product/plugin-prd.md) |
| Visual language | [`product/design.md`](product/design.md) |
| Deploy / operate | [`ops/self-hosting.md`](ops/self-hosting.md) |
| Why we chose X | [`adr/`](adr/) |
| Older proposals / history | [`proposals/`](proposals/), [`history/`](history/) |

## Layout

```
docs/
  architecture.md     ← sync pipeline (start here for engineering)
  product/            ← PRDs + design
  ops/                ← self-hosting
  adr/                ← architecture decision records
  proposals/          ← accepted + historical design docs
  history/            ← build-slices + old plans
```

Prefer `architecture.md` and current ADRs for **shipped** behavior. For the in-flight SQLite text + conflict UX work, the proposal + ADR 0010 are authoritative until architecture.md is rewritten after ship.
