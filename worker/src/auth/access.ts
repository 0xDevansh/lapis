import type { VaultPermission, VaultRole } from "./permissions";
import { roleHasPermission } from "./permissions";

export interface VaultMembership {
  vaultId: string;
  userId: string;
  role: VaultRole;
  name: string;
  createdAt: string;
}

export class AccessError extends Error {
  constructor(
    message: string,
    public status: 403 | 404 = 404
  ) {
    super(message);
    this.name = "AccessError";
  }
}

export async function getMembership(
  db: D1Database,
  vaultId: string,
  userId: string
): Promise<{ role: VaultRole } | null> {
  const row = await db
    .prepare(
      `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
    )
    .bind(vaultId, userId)
    .first<{ role: VaultRole }>();
  return row ?? null;
}

/**
 * Resolve vault access. Non-members get 404 (no existence leak).
 * Members without the permission get 403.
 */
export async function requireVaultAccess(
  db: D1Database,
  vaultId: string,
  userId: string,
  permission: VaultPermission
): Promise<{ id: string; name: string; createdAt: string; role: VaultRole }> {
  const vault = await db
    .prepare(
      `SELECT v.id, v.name, v.created_at AS createdAt, m.role AS role
       FROM vaults v
       INNER JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ?
       WHERE v.id = ?`
    )
    .bind(userId, vaultId)
    .first<{ id: string; name: string; createdAt: string; role: VaultRole }>();

  if (!vault) {
    throw new AccessError("Not found", 404);
  }
  if (!roleHasPermission(vault.role, permission)) {
    throw new AccessError("Forbidden", 403);
  }
  return vault;
}

export async function listMemberVaults(
  db: D1Database,
  userId: string
): Promise<Array<{ id: string; name: string; createdAt: string; role: VaultRole }>> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.name, v.created_at AS createdAt, m.role AS role
       FROM vaults v
       INNER JOIN vault_members m ON m.vault_id = v.id
       WHERE m.user_id = ?
       ORDER BY v.created_at DESC`
    )
    .bind(userId)
    .all<{ id: string; name: string; createdAt: string; role: VaultRole }>();
  return results ?? [];
}

export async function addVaultOwner(
  db: D1Database,
  vaultId: string,
  userId: string,
  createdAt: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vault_members (vault_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`
    )
    .bind(vaultId, userId, createdAt)
    .run();
}
