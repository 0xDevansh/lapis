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
