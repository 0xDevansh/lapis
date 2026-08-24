/**
 * Sync token authentication middleware — Slice 07 / 23.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getDeviceByToken } from "../devices/record";
import { identityFromRecord, type ConflictPolicy } from "../devices/types";
import type { DeviceKind } from "../vault/identity";
import { resolveVaultAccess, roleCanWrite, type VaultRole } from "../vault/access";

export interface DeviceContext {
  id: string;
  vaultId: string;
  deviceName: string;
  kind: DeviceKind;
  conflictPolicy: ConflictPolicy;
  receiveInternals: boolean;
  author: string;
  userId: string;
  role: VaultRole;
  writable: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    device: DeviceContext;
  }
}

export function denyDeviceWrite(c: Context<{ Bindings: Env }>): Response | null {
  if (!c.get("device").writable) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null;
}

export const requireDevice: MiddlewareHandler<{ Bindings: Env }> = async (
  c: Context<{ Bindings: Env }>,
  next
) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : c.req.query("token")?.trim() ?? "";

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const record = await getDeviceByToken(c.env.DB, token);
  if (!record) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const vault = await c.env.DB.prepare(
    `SELECT archived_at AS archivedAt FROM vaults WHERE id = ?`
  )
    .bind(record.vaultId)
    .first<{ archivedAt: string | null }>();
  if (vault?.archivedAt) {
    return c.json(
      { error: "Vault is archived", archivedAt: vault.archivedAt },
      423 as 400
    );
  }

  const userId = record.userId || record.ownerId;
  const access = await resolveVaultAccess(c.env.DB, record.vaultId, userId);
  if (!access) {
    return c.json({ error: "Forbidden" }, 403);
  }

  c.env.DB.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), record.id)
    .run()
    .catch(() => {});

  const identity = identityFromRecord(record);
  c.set("device", {
    id: record.id,
    vaultId: record.vaultId,
    deviceName: record.deviceName,
    kind: record.kind,
    conflictPolicy: record.conflictPolicy,
    receiveInternals: record.receiveInternals,
    author: identity.author,
    userId,
    role: access.role,
    writable: roleCanWrite(access.role),
  });

  await next();
};
