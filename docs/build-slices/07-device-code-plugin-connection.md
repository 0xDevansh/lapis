# 07. Device-Code Plugin Connection

## What to build

Connect the Obsidian plugin to Lapis with a device-code flow, revocable per-device credentials, and a visible device list for each Web Vault.

## Acceptance criteria

- [ ] The plugin can start a device-code connection flow for a selected Web Vault.
- [ ] The Vault Owner can approve the device from the authenticated web product.
- [ ] Each connected Local Vault/device receives revocable sync credentials that are not Artifacts tokens.
- [ ] The Web Vault shows connected devices.
- [ ] A Vault Owner can revoke a device and prevent further sync from it.
- [ ] Each device can configure whether it wants to receive Vault Internals updates.

## Blocked by

- 01. Deployable Shell And Web Vault Creation
