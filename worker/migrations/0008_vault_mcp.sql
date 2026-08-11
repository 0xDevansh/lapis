-- Vault-scoped MCP access controls (enable + path allow/deny + tool flags).
CREATE TABLE IF NOT EXISTS vault_mcp_settings (
  vault_id        TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 0,
  read_only       INTEGER NOT NULL DEFAULT 0,
  allow_paths     TEXT NOT NULL DEFAULT '[]',
  deny_paths      TEXT NOT NULL DEFAULT '[]',
  allow_write     INTEGER NOT NULL DEFAULT 1,
  allow_search    INTEGER NOT NULL DEFAULT 1,
  allow_delete    INTEGER NOT NULL DEFAULT 0,
  max_read_bytes  INTEGER NOT NULL DEFAULT 1048576,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE
);
