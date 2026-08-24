-- Vault membership and in-app invites (Better Auth user ids / emails)
--
-- Some local/remote DBs already applied an older 0007_vault_members.sql that
-- created vault_members and a token-based vault_invites table (token, expires_at,
-- no status). CREATE TABLE IF NOT EXISTS would skip, then indexes on `status` fail.
-- Rebuild invites onto the current schema in all cases.

CREATE TABLE IF NOT EXISTS vault_members (
  vault_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id),
  FOREIGN KEY (vault_id) REFERENCES vaults(id)
);

CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members (user_id);
CREATE INDEX IF NOT EXISTS idx_vault_members_vault ON vault_members (vault_id);

CREATE TABLE IF NOT EXISTS vault_invites (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES vaults(id)
);

CREATE TABLE IF NOT EXISTS vault_invites__new (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES vaults(id)
);

INSERT OR IGNORE INTO vault_invites__new (id, vault_id, email, role, invited_by, status, created_at)
SELECT
  id,
  vault_id,
  email,
  role,
  invited_by,
  'pending',
  created_at
FROM vault_invites;

DROP TABLE vault_invites;
ALTER TABLE vault_invites__new RENAME TO vault_invites;

CREATE INDEX IF NOT EXISTS idx_vault_invites_email_status ON vault_invites (email, status);
CREATE INDEX IF NOT EXISTS idx_vault_invites_vault ON vault_invites (vault_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_invites_pending
  ON vault_invites (vault_id, email)
  WHERE status = 'pending';

INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at
FROM vaults
WHERE NOT EXISTS (
  SELECT 1 FROM vault_members m WHERE m.vault_id = vaults.id AND m.user_id = vaults.owner_id
);
