-- Account-wide MCP personal access tokens (hashed at rest).

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  last4        TEXT NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user
  ON mcp_tokens (user_id, revoked, created_at);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash
  ON mcp_tokens (token_hash)
  WHERE revoked = 0;
