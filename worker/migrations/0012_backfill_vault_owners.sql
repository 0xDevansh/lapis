-- Idempotent owner backfill for vaults created before membership existed.
-- Safe if 0010 already inserted rows, and if an older 0007_vault_members.sql
-- created the table without copying every vault owner.

INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at
FROM vaults;
