-- Multi-user vault membership (ADR 0009)

CREATE TABLE IF NOT EXISTS vault_members (
  vault_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members (user_id);
CREATE INDEX IF NOT EXISTS idx_vault_members_vault ON vault_members (vault_id);

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

CREATE INDEX IF NOT EXISTS idx_vault_invites_vault ON vault_invites (vault_id);
CREATE INDEX IF NOT EXISTS idx_vault_invites_token ON vault_invites (token);
CREATE INDEX IF NOT EXISTS idx_vault_invites_email ON vault_invites (email);

-- Backfill: every existing vault owner becomes a member
INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at FROM vaults;
