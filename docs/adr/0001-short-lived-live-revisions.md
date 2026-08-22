# Short-Lived Live Revisions Before Git Commits

The web vault may expose server-accepted changes before those changes are sealed into Artifacts as Git commits, because near-immediate cross-client reflection is part of the product experience. These live revisions must be short-lived, with R2 updated immediately for browsing/sync and Artifacts commits created after a brief 2-10 second debounce, so the system preserves a simple recovery and rollback model without making every keystroke or small edit a separate commit.
