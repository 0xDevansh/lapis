# Auth-Gated Vaults Without End-To-End Encryption

## Status

Accepted. Membership model extended by [ADR 0009](0009-multi-user-vault-members.md).

## Decision

Lapis uses auth-gated private vault access rather than end-to-end encryption. E2EE would make browser rendering, search, backlinks, and server-side CRDT hosting substantially harder, so the open-source self-deployed product keeps normal authenticated private storage.

Access is session- or device-authenticated and authorized by vault membership role (`owner` / `editor` / `viewer`). Google OAuth and email/password are both supported via better-auth. E2EE remains out of scope.
