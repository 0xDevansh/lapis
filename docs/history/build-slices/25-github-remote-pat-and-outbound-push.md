# 25. GitHub Remote — PAT Storage And Outbound Push

## What to build

Let an owner connect a GitHub repository to a vault with a Personal Access Token, and push
the vault's sealed history to that GitHub repo instead of (or alongside) Cloudflare
Artifacts. This is the outbound half of GitHub sync; inbound + conflict handling is Slice 26.

## Why

The sealer already speaks standard git over HTTP via isomorphic-git (clone/add/commit/push).
GitHub is a drop-in remote once auth and remote-config are generalized. Doing outbound first
gives an immediately useful, low-risk feature and sets up the `GitRemote` abstraction that
Slice 26 extends with pull/merge.

## Acceptance criteria

- [ ] An owner can configure a GitHub remote for a vault: repo URL, branch (default `main`),
      optional subdirectory, and a PAT. Stored in a new `vault_git_remotes` table.
- [ ] The PAT is encrypted at rest (AES-GCM with a Worker-held key) and **never** returned
      in any API response; only `pat_last4` and non-secret metadata are readable.
- [ ] A `GitRemote` interface abstracts the git target; `ArtifactsRemote` and `GitHubRemote`
      both implement it. The existing sealer is refactored to call through it.
- [ ] On the seal trigger, the vault's changed tree is committed and pushed to the configured
      GitHub branch with the PAT; commit author reflects the originating device
      (`${kind}:${id}`) where known, else `Lapis`.
- [ ] Push debounces exactly like the R2 flush/seal (a 5-edits/sec burst → one push).
- [ ] Non-fast-forward push rejection is surfaced as a recoverable `sync_state='conflict'`
      (full reconciliation loop lands in Slice 26); outbound-only mode does not corrupt state.
- [ ] The snapshots UI (`getVaultLog`, `readFileAtCommit`) reads from the GitHub remote and
      keeps working.
- [ ] Connecting/disconnecting a GitHub remote is covered by owner-auth routes and tests.

## Blocked by

- 04. Artifacts Sealed History
- 23. Unified Device Model

## Implementation notes

### Data model
- `worker/migrations/0010_git_remotes.sql`:
  ```sql
  CREATE TABLE vault_git_remotes (
    vault_id           TEXT PRIMARY KEY,
    provider           TEXT NOT NULL DEFAULT 'github',
    repo_url           TEXT NOT NULL,
    branch             TEXT NOT NULL DEFAULT 'main',
    subdir             TEXT,
    pat_ciphertext     TEXT NOT NULL,
    pat_last4          TEXT,
    last_synced_commit TEXT,
    last_synced_at     TEXT,
    sync_state         TEXT NOT NULL DEFAULT 'idle'  -- idle|pulling|pushing|conflict
  );
  ```
- Also persist `last_synced_commit` mirror in the DO (`do_state`) so the coordinator can read
  it without a D1 round trip on the mutation path.

### Secret handling
- Add a `GITHUB_PAT_ENCRYPTION_KEY` secret (documented in `wrangler.jsonc` comments + `self-hosting.md`).
- `worker/src/git/crypto.ts` (new): `encryptPat` / `decryptPat` using WebCrypto AES-GCM.
- Never log or return plaintext PATs. Redact in error paths.

### GitRemote abstraction
- `worker/src/git/remote.ts` (new): `interface GitRemote { url; branch; onAuth(): {username;password}; }`.
- `worker/src/git/github-remote.ts`: builds `onAuth` from the decrypted PAT
  (`username: "x-access-token", password: pat` works for GitHub HTTPS).
- Refactor `worker/src/artifacts/sealer.ts` `sealVault` / `getVaultLog` / `readFileAtCommit`
  to accept a `GitRemote` instead of the hardcoded Artifacts remote + token. `ArtifactsRemote`
  wraps `ensureRepoAndToken`. Keep Artifacts fully working (do not delete it here).

### Coordinator
- `sealNow` chooses the configured remote: GitHub if `vault_git_remotes` exists, else Artifacts.
- Respect the `subdir` prefix when writing files into the git tree.
- On push rejection, set `sync_state='conflict'` and stop (Slice 26 adds the merge loop).

### Routes (owner-authenticated)
- `PUT /api/vaults/:id/git-remote` — connect/update (`{ repoUrl, branch, subdir, pat }`).
- `GET /api/vaults/:id/git-remote` — return metadata + `pat_last4` (never the PAT).
- `DELETE /api/vaults/:id/git-remote` — disconnect.
- `POST /api/vaults/:id/git-remote/push` — manual push trigger.

### Tests
- PAT round-trips through encrypt/decrypt; ciphertext != plaintext; API never emits plaintext.
- Outbound push writes expected tree/commit (against a local bare repo or mocked http).
- Debounce: N rapid mutations → one push.
