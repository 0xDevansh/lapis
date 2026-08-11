# Multi-User Vault Members And Roles

## Status

Accepted.

## Context

Lapis gated every vault API on `vaults.owner_id === session.userId`. Devices were the owner’s sync agents, not other people. Collaborative vaults need multiple human members with different privileges, Google sign-in for easier onboarding, and a clear ACL without adopting a full multi-tenant “organization = vault” product model.

## Decision

1. **Custom membership tables**, not the better-auth organization plugin:
   - `vault_members(vault_id, user_id, role, created_at)` with roles `owner` | `editor` | `viewer`
   - `vault_invites` for link-based invites (email delivery optional for self-host)
   - Keep `vaults.owner_id` as the denormalized primary owner for delete/transfer

2. **better-auth access control** via `createAccessControl` / `newRole` for static statements. Enforce with a shared `requireVaultAccess(vaultId, userId, permission)` helper on vault, search, device, git, and Yjs routes.

3. **Role capabilities:**
   - `owner` — full content, members/invites, devices, git remote, delete vault
   - `editor` — read/write content; may approve devices they create; no member admin, no vault delete, no git remote admin
   - `viewer` — read-only Yjs sync (updates rejected server-side)

4. **Google OAuth** via better-auth `socialProviders.google`, alongside email/password.

5. **Devices** remain vault-scoped sync agents. Device-code approval requires owner or editor membership. `devices.owner_id` becomes `created_by` (the member who paired the device).

## Consequences

- `GET /api/vaults` returns vaults the user owns or is a member of, including `role`.
- Solo-owner deployments still work: creating a vault inserts the creator as `owner`.
- Invitation UX and ACL tests become part of the auth surface.
- Organization/teams-as-workspaces that own many vaults remain out of scope.
