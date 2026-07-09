-- Slice 25: GitHub remote configuration per vault
CREATE TABLE IF NOT EXISTS vault_git_remotes (
  vault_id           TEXT PRIMARY KEY,
  provider           TEXT NOT NULL DEFAULT 'github',
  repo_url           TEXT NOT NULL,
  branch             TEXT NOT NULL DEFAULT 'main',
  subdir             TEXT,
  pat_ciphertext     TEXT NOT NULL,
  pat_last4          TEXT,
  webhook_secret     TEXT,
  last_synced_commit TEXT,
  last_synced_at     TEXT,
  sync_state         TEXT NOT NULL DEFAULT 'idle'
);
