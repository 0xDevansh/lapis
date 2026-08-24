-- Bind paired devices to the member who approved them so role-based
-- read/write is evaluated at request time, not only at mint.

ALTER TABLE devices ADD COLUMN user_id TEXT;
ALTER TABLE device_codes ADD COLUMN approved_by TEXT;

UPDATE devices SET user_id = owner_id WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);
