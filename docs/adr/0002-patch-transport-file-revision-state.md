# Patch Transport With File Revision State

**Status:** Accepted — current (revision/patch sync; not Yjs).

Clients send file-diff patches for text-like vault content to reduce sync payload size, while binary attachments use whole-object transfers. The server applies patches against known base revisions and stores the accepted result as a normal file revision, with server-side three-way merge attempted when a patch is stale, so the product avoids realtime collaborative editing protocols while still syncing efficiently.
