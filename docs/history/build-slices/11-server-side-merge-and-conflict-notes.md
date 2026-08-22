# 11. Server-Side Merge And Conflict Notes

## What to build

Handle stale patches and concurrent edits safely by attempting server-side three-way merge for text files and creating visible Conflict Notes when automatic merge is unsafe.

## Acceptance criteria

- [ ] Stale text patches trigger server-side three-way merge using base, client, and current server versions.
- [ ] Clean merges are accepted as normal file revisions.
- [ ] Unsafe merges create Markdown Conflict Notes under `.sync-conflicts/`.
- [ ] Conflict Notes include full server, client, and base context plus path, revisions, device, timestamp, and status metadata.
- [ ] Original files are not overwritten by unsafe client changes.
- [ ] Deleting a Conflict Note marks the conflict resolved by ordinary sync behavior.
- [ ] Binary conflicts keep both versions through a Conflict Note or equivalent attached conflict artifact.

## Blocked by

- 09. Plugin Patch Sync Online
