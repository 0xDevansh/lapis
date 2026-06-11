-- Lapis D1 schema
-- Applied via wrangler d1 migrations apply or the /api/admin/migrate endpoint in dev.

-- better-auth tables (auto-created by better-auth on first run, included here for reference)
-- user, session, account, verification

-- Vaults (owner index; authoritative vault metadata also lives in the VaultCoordinator DO)
CREATE TABLE IF NOT EXISTS vaults (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vaults_owner ON vaults (owner_id);

-- ── Search + backlinks + tags indexes (Slice 06) ──────────────────────────────

-- FTS virtual table for full-text search over Vault Content.
-- Each row represents one file; content is the plaintext for Markdown files.
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
  vault_id UNINDEXED,
  path     UNINDEXED,
  filename,
  content,
  tokenize = 'porter unicode61'
);

-- Backlinks: (source_path) → (target_path) extracted from [[wikilinks]].
-- Both paths are stored lower-cased for case-insensitive comparison.
CREATE TABLE IF NOT EXISTS backlinks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id    TEXT NOT NULL,
  source_path TEXT NOT NULL,   -- path of the note that contains the wikilink
  target_path TEXT NOT NULL,   -- resolved path the wikilink points to (lower-cased)
  UNIQUE (vault_id, source_path, target_path)
);

CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (vault_id, target_path);
CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks (vault_id, source_path);

-- Note tags: one row per (note, tag) pair.
CREATE TABLE IF NOT EXISTS note_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id    TEXT NOT NULL,
  note_path   TEXT NOT NULL,
  tag         TEXT NOT NULL,
  UNIQUE (vault_id, note_path, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag  ON note_tags (vault_id, tag);
CREATE INDEX IF NOT EXISTS idx_note_tags_path ON note_tags (vault_id, note_path);
