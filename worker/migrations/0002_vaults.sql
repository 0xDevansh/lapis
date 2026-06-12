-- Vault registry

CREATE TABLE IF NOT EXISTS vaults (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vaults_owner ON vaults (owner_id);
