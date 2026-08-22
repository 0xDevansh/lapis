# Short-Lived Live Revisions Before Git Commits

**Status:** Accepted — current (revision/patch sync; not Yjs).

The web vault may expose server-accepted changes before those changes are sealed into Artifacts as Git commits, because near-immediate cross-client reflection is part of the product experience. These live revisions must be short-lived: the Durable Object accepts writes immediately and notifies peers, R2 is updated on a short flush debounce (~10s), and Artifacts/GitHub commits are created after a longer seal debounce (~minutes), so the system preserves a simple recovery model without making every small edit a separate commit.
