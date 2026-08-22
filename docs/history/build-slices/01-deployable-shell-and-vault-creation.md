# 01. Deployable Shell And Web Vault Creation

## What to build

Create the first deployable Lapis tracer bullet: a self-hosted Cloudflare app with web login, a minimal authenticated UI, vault-level coordination, and the ability for a Vault Owner to create an empty Web Vault that appears in their vault list.

## Acceptance criteria

- [ ] A self-hosting operator can configure and run the Worker/web app locally with Wrangler where possible.
- [ ] A Vault Owner can sign in through better-auth-backed web auth.
- [ ] A Vault Owner can create an empty Web Vault.
- [ ] The created Web Vault has durable vault metadata and a unique vault identity.
- [ ] The authenticated UI lists the Vault Owner's Web Vaults.
- [ ] Unauthenticated requests cannot access vault data.

## Blocked by

None - can start immediately.

## Implementation notes

**Status: complete** — committed as `slice/01-deployable-shell`.

### What was built

- **`pnpm-workspace.yaml`** monorepo with two packages: `worker/` and `web/`.
- **`.npmrc`** overrides the `@cloudflare` registry to `registry.npmjs.org` (the global user config routes to a private Cloudflare gateway that requires internal auth; this project is self-hosted so public registry is correct).
- **`worker/`** — Cloudflare Worker (Hono v4, better-auth v1, Durable Objects):
  - `src/index.ts` — main Hono router; mounts `/api/auth/*` → better-auth, `/api/vaults` → vault routes, and an SPA asset fallback.
  - `src/types.ts` — `Env` interface (VAULT_COORDINATOR, VAULT_BUCKET, DB, KV, ASSETS, secrets).
  - `src/auth/index.ts` — `createAuth(env)` wrapping better-auth with D1 and email+password.
  - `src/middleware/auth.ts` — `requireSession` middleware using better-auth `getSession`.
  - `src/vault/coordinator.ts` — `VaultCoordinator` Durable Object (SQLite storage, `initialize`, `getMeta`).
  - `src/vault/routes.ts` — `POST /api/vaults` (create), `GET /api/vaults` (list), `GET /api/vaults/:id` (get).
  - `src/db/schema.sql` — D1 schema reference; `POST /api/admin/migrate` applies it locally.
  - `worker-configuration.d.ts` — wrangler-generated runtime types (no `@cloudflare/workers-types` dependency needed).
  - `wrangler.jsonc` — bindings for VAULT_COORDINATOR DO, VAULT_BUCKET R2, DB D1, KV, and static ASSETS.
  - `.dev.vars.example` — documents required secrets (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`).
- **`web/`** — React 18 + Vite SPA:
  - `src/api.ts` — typed fetch helpers for auth and vault endpoints.
  - `src/hooks/useAuth.ts` — `useAuth()` hook (session load, sign-in, sign-up, sign-out).
  - `src/pages/AuthPage.tsx` — sign-in / sign-up form with tab switch.
  - `src/pages/VaultListPage.tsx` — vault list + create-vault form.
  - `src/App.tsx` — top-level router; gates all routes behind `useAuth`.
  - Vite dev proxy forwards `/api` to `localhost:8787`.

### Acceptance criteria status

- [x] A self-hosting operator can configure and run locally with Wrangler (`wrangler dev`, `.dev.vars`).
- [x] A Vault Owner can sign in through better-auth-backed web auth.
- [x] A Vault Owner can create an empty Web Vault.
- [x] The created Web Vault has durable vault metadata (VaultCoordinator DO) and a unique UUID vault identity.
- [x] The authenticated UI lists the Vault Owner's Web Vaults.
- [x] Unauthenticated requests to `/api/vaults` return HTTP 401.

### Known gaps / follow-ups

- `POST /api/admin/migrate` only runs in local dev (gated on `localhost` in `BETTER_AUTH_URL`); production needs a proper migration strategy (addressed in Slice 14).
- better-auth auto-creates its own tables on first request; the `vaults` table must be applied separately via the migrate endpoint or manual `wrangler d1 execute`.
