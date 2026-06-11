# 04. Artifacts Sealed History

## What to build

Seal accepted live revisions into Artifacts as Git commits after a short debounce, without exposing Artifacts tokens to normal clients. Show a basic vault-level timeline of sealed commits.

## Acceptance criteria

- [ ] Each Web Vault maps to an Artifacts repository.
- [ ] Server-created commits seal accepted live revisions after a 2-10 second debounce.
- [ ] Normal web clients and plugins never receive direct Artifacts repo tokens.
- [ ] The Web Vault exposes a timeline of sealed commits with timestamp and source labels where available.
- [ ] R2 remains the latest browsing read model while Artifacts is the sealed version-history store.
- [ ] Failures during sealing are visible to operators and retryable without corrupting R2 latest state.

## Blocked by

- 03. Web File Operations With Live Revisions
