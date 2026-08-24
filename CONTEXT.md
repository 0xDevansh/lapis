# Lapis

Lapis is a web-first product for accessing and managing Obsidian vaults from anywhere. Local sync and versioned backups support the web product, but they are not the product's primary identity.

## Language

**Web Vault**:
An Obsidian vault made accessible through the product's web interface without requiring Obsidian to be installed.
_Avoid_: Online backup, hosted folder

**Core Rendering**:
The web vault's first-slice compatibility target for displaying Obsidian notes: Markdown, wikilinks, embeds, backlinks, tags, frontmatter, attachments, common callouts, and built-in themes. It does not include running Obsidian community plugins or emulating Obsidian's plugin runtime.
_Avoid_: Obsidian clone, plugin compatibility

**Local Vault**:
An Obsidian vault stored on a user's device and connected to the product through an Obsidian plugin.
_Avoid_: Client copy, replica

**Vault Content**:
The notes and attachments that are visible and manageable in the web vault. Vault content excludes `.obsidian` and other internal or device-specific files.
_Avoid_: Every file, raw vault folder

**Vault Internals**:
Device-specific or application-specific files inside a local vault, including `.obsidian` data. Vault internals are hidden from the normal web vault and each local vault can choose whether to receive updates to them.
_Avoid_: User content, normal files

**Conflict Note**:
A Markdown note created under `.sync-conflicts/` when the product cannot automatically merge competing edits to the same vault content. Conflict notes are visible vault content and include enough context for the vault owner to resolve the conflict from either the web vault or a local vault.
_Avoid_: Error log, hidden sync metadata

**Published Page**:
A selected vault page exposed outside the private web vault experience. Publishing is a later capability, not part of the first product slice.
_Avoid_: Public vault, share link

**Vault Owner**:
The person who created a web vault and retains admin control: archive, MCP policy, GitHub remotes, and member roles.

**Editor**:
A Better Auth user invited to a web vault who can read and write vault content, invite other editors and viewers, and pair a plugin or MCP client with write access.

**Viewer**:
A Better Auth user invited to a web vault who can read vault content and pair a read-only plugin or MCP client, but cannot edit, invite, or change vault settings.
_Avoid_: Team member, collaborator, publisher
