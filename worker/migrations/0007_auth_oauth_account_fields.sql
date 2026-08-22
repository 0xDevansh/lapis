-- Better Auth 1.6 OAuth account fields.
-- The original schema used a single `expiresAt` column from an older release;
-- Google sign-in writes the provider-specific fields below.

ALTER TABLE "account" ADD COLUMN accessTokenExpiresAt TEXT;
ALTER TABLE "account" ADD COLUMN refreshTokenExpiresAt TEXT;
ALTER TABLE "account" ADD COLUMN scope TEXT;

CREATE INDEX IF NOT EXISTS account_userId_idx ON "account"(userId);
CREATE INDEX IF NOT EXISTS session_userId_idx ON "session"(userId);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier);
