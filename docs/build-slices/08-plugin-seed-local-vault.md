# 08. Plugin Seed Local Vault

## What to build

Allow an existing Local Vault to seed a new Web Vault through the plugin with progress, resumability, safe ignore defaults, and initial R2/Artifacts/search materialization.

## Acceptance criteria

- [ ] The plugin inventories an existing Local Vault and separates Vault Content from Vault Internals.
- [ ] Initial upload shows progress and can resume after interruption.
- [ ] OS junk and cache files are ignored by default.
- [ ] Uploaded Vault Content becomes visible in the Web Vault browser.
- [ ] The initial imported state is sealed into Artifacts history.
- [ ] Search, backlinks, tags, and manifest state are populated from the seeded vault.

## Blocked by

- 04. Artifacts Sealed History
- 06. Search, Backlinks, And Tags
- 07. Device-Code Plugin Connection
