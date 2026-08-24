-- Vault lifecycle and MCP policy.

ALTER TABLE "account" ADD COLUMN issuer TEXT;

ALTER TABLE vaults ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_owner_active
  ON vaults (owner_id, archived_at, created_at);

CREATE TABLE IF NOT EXISTS jwks (
  id          TEXT PRIMARY KEY,
  publicKey   TEXT NOT NULL,
  privateKey  TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT,
  alg         TEXT,
  crv         TEXT
);

CREATE TABLE IF NOT EXISTS oauthClient (
  id                                  TEXT PRIMARY KEY,
  clientId                            TEXT NOT NULL UNIQUE,
  clientSecret                        TEXT,
  clientDiscoveryId                   TEXT,
  disabled                            INTEGER DEFAULT 0,
  skipConsent                         INTEGER,
  enableEndSession                    INTEGER,
  subjectType                         TEXT,
  scopes                              TEXT,
  clientCredentialsScopes             TEXT,
  userId                              TEXT REFERENCES "user"(id),
  createdAt                           TEXT,
  updatedAt                           TEXT,
  name                                TEXT,
  uri                                 TEXT,
  icon                                TEXT,
  contacts                            TEXT,
  tos                                 TEXT,
  policy                              TEXT,
  softwareId                          TEXT,
  softwareVersion                     TEXT,
  softwareStatement                   TEXT,
  redirectUris                        TEXT NOT NULL,
  postLogoutRedirectUris              TEXT,
  backchannelLogoutUri                TEXT,
  backchannelLogoutSessionRequired    INTEGER,
  tokenEndpointAuthMethod             TEXT,
  applicationType                     TEXT,
  jwks                                TEXT,
  jwksUri                             TEXT,
  grantTypes                          TEXT,
  responseTypes                       TEXT,
  requirePKCE                         INTEGER,
  dpopBoundAccessTokens               INTEGER DEFAULT 0,
  referenceId                         TEXT,
  metadata                            TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauthClient_userId ON oauthClient(userId);

CREATE TABLE IF NOT EXISTS oauthResource (
  id                              TEXT PRIMARY KEY,
  identifier                      TEXT NOT NULL UNIQUE,
  name                            TEXT NOT NULL,
  accessTokenTtl                  INTEGER,
  refreshTokenTtl                 INTEGER,
  signingAlgorithm                TEXT,
  signingKeyId                    TEXT,
  allowedScopes                   TEXT,
  customClaims                    TEXT,
  dpopBoundAccessTokensRequired   INTEGER DEFAULT 0,
  disabled                        INTEGER DEFAULT 0,
  createdAt                       TEXT,
  updatedAt                       TEXT,
  policyVersion                   INTEGER DEFAULT 1,
  metadata                        TEXT
);

CREATE TABLE IF NOT EXISTS oauthClientResource (
  id          TEXT PRIMARY KEY,
  clientId    TEXT NOT NULL REFERENCES oauthClient(id) ON DELETE CASCADE,
  resourceId  TEXT NOT NULL REFERENCES oauthResource(id) ON DELETE CASCADE,
  metadata    TEXT,
  createdAt   TEXT,
  UNIQUE(clientId, resourceId)
);

CREATE INDEX IF NOT EXISTS idx_oauthClientResource_clientId ON oauthClientResource(clientId);
CREATE INDEX IF NOT EXISTS idx_oauthClientResource_resourceId ON oauthClientResource(resourceId);

CREATE TABLE IF NOT EXISTS oauthRefreshToken (
  id                       TEXT PRIMARY KEY,
  token                    TEXT NOT NULL UNIQUE,
  clientId                 TEXT NOT NULL REFERENCES oauthClient(id),
  sessionId                TEXT REFERENCES "session"(id) ON DELETE SET NULL,
  userId                   TEXT NOT NULL REFERENCES "user"(id),
  referenceId              TEXT,
  authorizationCodeId      TEXT,
  resources                TEXT,
  requestedUserInfoClaims  TEXT,
  expiresAt                TEXT NOT NULL,
  createdAt                TEXT NOT NULL,
  revoked                  TEXT,
  rotatedAt                TEXT,
  rotationReplayResponse   TEXT,
  rotationReplayExpiresAt  TEXT,
  authTime                 TEXT,
  confirmation             TEXT,
  scopes                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauthRefreshToken_clientId ON oauthRefreshToken(clientId);
CREATE INDEX IF NOT EXISTS idx_oauthRefreshToken_sessionId ON oauthRefreshToken(sessionId);
CREATE INDEX IF NOT EXISTS idx_oauthRefreshToken_userId ON oauthRefreshToken(userId);
CREATE INDEX IF NOT EXISTS idx_oauthRefreshToken_authorizationCodeId ON oauthRefreshToken(authorizationCodeId);

CREATE TABLE IF NOT EXISTS oauthAccessToken (
  id                       TEXT PRIMARY KEY,
  token                    TEXT UNIQUE,
  clientId                 TEXT NOT NULL REFERENCES oauthClient(id),
  sessionId                TEXT REFERENCES "session"(id) ON DELETE SET NULL,
  userId                   TEXT REFERENCES "user"(id),
  referenceId              TEXT,
  authorizationCodeId      TEXT,
  resources                TEXT,
  requestedUserInfoClaims  TEXT,
  refreshId                TEXT REFERENCES oauthRefreshToken(id),
  expiresAt                TEXT NOT NULL,
  createdAt                TEXT NOT NULL,
  revoked                  TEXT,
  confirmation             TEXT,
  scopes                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_clientId ON oauthAccessToken(clientId);
CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_sessionId ON oauthAccessToken(sessionId);
CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_userId ON oauthAccessToken(userId);
CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_refreshId ON oauthAccessToken(refreshId);
CREATE INDEX IF NOT EXISTS idx_oauthAccessToken_authorizationCodeId ON oauthAccessToken(authorizationCodeId);

CREATE TABLE IF NOT EXISTS oauthConsent (
  id                       TEXT PRIMARY KEY,
  clientId                 TEXT NOT NULL REFERENCES oauthClient(id),
  userId                   TEXT REFERENCES "user"(id),
  referenceId              TEXT,
  resources                TEXT,
  requestedUserInfoClaims  TEXT,
  scopes                   TEXT NOT NULL,
  createdAt                TEXT NOT NULL,
  updatedAt                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauthConsent_clientId ON oauthConsent(clientId);
CREATE INDEX IF NOT EXISTS idx_oauthConsent_userId ON oauthConsent(userId);

CREATE TABLE IF NOT EXISTS oauthClientAssertion (
  id         TEXT PRIMARY KEY,
  expiresAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_mcp_policies (
  vault_id          TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  mode              TEXT NOT NULL DEFAULT 'read-only',
  allow_grep        INTEGER NOT NULL DEFAULT 1,
  allow_delete      INTEGER NOT NULL DEFAULT 0,
  allow_internals   INTEGER NOT NULL DEFAULT 0,
  path_allow        TEXT,
  path_deny         TEXT,
  max_read_bytes    INTEGER NOT NULL DEFAULT 131072,
  max_write_bytes   INTEGER NOT NULL DEFAULT 131072,
  max_results       INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_mcp_owner_enabled
  ON vault_mcp_policies (owner_id, enabled);
