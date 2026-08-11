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

-- Multi-user membership (ADR 0009)
CREATE TABLE IF NOT EXISTS vault_members (
  vault_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members (user_id);

CREATE TABLE IF NOT EXISTS vault_invites (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  token      TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

-- ── Device-code plugin connection (Slice 07) ──────────────────────────────────

-- Pending device-code flows (expire after 10 minutes).
CREATE TABLE IF NOT EXISTS device_codes (
  device_code     TEXT PRIMARY KEY,   -- opaque secret sent to plugin
  user_code       TEXT NOT NULL,      -- short human-readable code shown in UI
  vault_id        TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  device_name     TEXT NOT NULL,      -- label provided by the plugin
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes (vault_id, user_code);
CREATE INDEX IF NOT EXISTS idx_device_codes_owner     ON device_codes (owner_id, status);

-- Approved connected devices with revocable sync tokens.
CREATE TABLE IF NOT EXISTS devices (
  id                  TEXT PRIMARY KEY,     -- device UUID
  vault_id            TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  device_name         TEXT NOT NULL,
  sync_token          TEXT NOT NULL UNIQUE, -- Bearer token used by the plugin
  receive_internals   INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
  revoked             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT,
  kind                TEXT NOT NULL DEFAULT 'plugin',
  capabilities        TEXT,
  conflict_policy     TEXT NOT NULL DEFAULT 'rebase',
  sync_cursor         TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_vault  ON devices (vault_id, revoked);
CREATE INDEX IF NOT EXISTS idx_devices_token  ON devices (sync_token);

-- ── GitHub remote (Slice 25) ─────────────────────────────────────────────────

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
