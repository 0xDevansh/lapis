import type { Context } from "hono";
import type { Env } from "../types";

export type VaultRole = "owner" | "editor" | "viewer";
export type VaultCapability = "read" | "write" | "invite" | "admin";

export interface VaultRow {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  ownerId: string;
}

export interface VaultAccess {
  vault: VaultRow;
  role: VaultRole;
}

export interface VaultWithRole {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  role: VaultRole;
}

const CAPABILITY_ROLES: Record<VaultCapability, readonly VaultRole[]> = {
  read: ["owner", "editor", "viewer"],
  write: ["owner", "editor"],
  invite: ["owner", "editor"],
  admin: ["owner"],
};

export function isVaultRole(value: string): value is VaultRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

export function hasCapability(role: VaultRole, cap: VaultCapability): boolean {
  return CAPABILITY_ROLES[cap].includes(role);
}

export function roleCanWrite(role: VaultRole): boolean {
  return hasCapability(role, "write");
}

export function publicVault(access: VaultAccess): VaultWithRole {
  return {
    id: access.vault.id,
    name: access.vault.name,
    createdAt: access.vault.createdAt,
    archivedAt: access.vault.archivedAt,
    role: access.role,
  };
}

export async function resolveVaultAccess(
  db: D1Database,
  vaultId: string,
  userId: string
): Promise<VaultAccess | null> {
  const row = await db
    .prepare(
      `SELECT v.id, v.name, v.created_at AS createdAt, v.archived_at AS archivedAt,
              v.owner_id AS ownerId, m.role AS role
       FROM vaults v
       JOIN vault_members m ON m.vault_id = v.id
       WHERE v.id = ? AND m.user_id = ?`
    )
    .bind(vaultId, userId)
    .first<VaultRow & { role: string }>();
  if (row && isVaultRole(row.role)) {
    return {
      vault: {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        ownerId: row.ownerId,
      },
      role: row.role,
    };
  }

  const owned = await db
    .prepare(
      `SELECT id, name, created_at AS createdAt, archived_at AS archivedAt, owner_id AS ownerId
       FROM vaults WHERE id = ? AND owner_id = ?`
    )
    .bind(vaultId, userId)
    .first<VaultRow>();
  if (!owned) return null;
  await insertOwnerMember(db, owned.id, userId, owned.createdAt);
  return { vault: owned, role: "owner" };
}

export function denyAccess(
  c: Context<{ Bindings: Env }>,
  access: VaultAccess | null,
  cap: VaultCapability,
  options?: { allowArchived?: boolean }
): Response | null {
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!hasCapability(access.role, cap)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!options?.allowArchived && access.vault.archivedAt) {
    return c.json(
      { error: "Vault is archived", archivedAt: access.vault.archivedAt },
      423 as 400
    );
  }
  return null;
}

export async function backfillVaultOwners(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, created_at)
       SELECT id, owner_id, 'owner', created_at FROM vaults`
    )
    .run();
}

export async function insertOwnerMember(
  db: D1Database,
  vaultId: string,
  userId: string,
  createdAt: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`
    )
    .bind(vaultId, userId, createdAt)
    .run();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getUserEmail(
  db: D1Database,
  userId: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT email FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<{ email: string }>();
  return row?.email ? normalizeEmail(row.email) : null;
}

export async function getUserByEmail(
  db: D1Database,
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  return db
    .prepare(`SELECT id, email, name FROM "user" WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<{ id: string; email: string; name: string }>();
}
