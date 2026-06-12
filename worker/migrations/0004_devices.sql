-- Device-code flow and connected devices

CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code   TEXT NOT NULL,
  vault_id    TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  device_name TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes (vault_id, user_code);
CREATE INDEX IF NOT EXISTS idx_device_codes_owner     ON device_codes (owner_id, status);

CREATE TABLE IF NOT EXISTS devices (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  device_name       TEXT NOT NULL,
  sync_token        TEXT NOT NULL UNIQUE,
  receive_internals INTEGER NOT NULL DEFAULT 0,
  revoked           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_vault ON devices (vault_id, revoked);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (sync_token);
