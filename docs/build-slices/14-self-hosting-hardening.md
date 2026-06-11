# 14. Self-Hosting Hardening And Documentation

## What to build

Make Lapis practical to self-deploy by documenting Cloudflare setup, required beta access, local development, optional deployment limits, and operational recovery paths.

## Acceptance criteria

- [ ] Documentation explains required Cloudflare services: Workers, Durable Objects, R2, Artifacts beta, and D1.
- [ ] Documentation covers single-account deployment configuration.
- [ ] Documentation covers local development with Wrangler/Miniflare where possible.
- [ ] Documentation explains optional upload/storage limits and the absence of built-in billing.
- [ ] Documentation explains Artifacts beta and platform limits that operators must understand.
- [ ] Operator-facing docs describe retry/recovery for failed Artifacts sealing and sync projection issues.

## Blocked by

- 13. Restore And Export
