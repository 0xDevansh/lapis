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
