-- Full-text search, backlinks, and tags

CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
  vault_id UNINDEXED,
  path     UNINDEXED,
  filename,
  content,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS backlinks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id    TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  UNIQUE (vault_id, source_path, target_path)
);

CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (vault_id, target_path);
CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks (vault_id, source_path);

CREATE TABLE IF NOT EXISTS note_tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id  TEXT NOT NULL,
  note_path TEXT NOT NULL,
  tag       TEXT NOT NULL,
  UNIQUE (vault_id, note_path, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag  ON note_tags (vault_id, tag);
CREATE INDEX IF NOT EXISTS idx_note_tags_path ON note_tags (vault_id, note_path);
