/**
 * Sync token authentication middleware — Slice 07.
 *
 * Validates `Authorization: Bearer <syncToken>` against the devices table.
 * Sets `c.set('device', { id, vaultId, receiveInternals })` on success.
 *
 * Used by sync endpoints (Slices 09+). Revoked devices are rejected.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";

export interface DeviceContext {
  id: string;
  vaultId: string;
  deviceName: string;
  receiveInternals: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    device: DeviceContext;
  }
}

type DeviceRow = {
  id: string;
  vault_id: string;
  device_name: string;
  receive_internals: number;
};

export const requireDevice: MiddlewareHandler<{ Bindings: Env }> = async (
  c: Context<{ Bindings: Env }>,
  next
) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : c.req.query("token")?.trim() ?? "";

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, vault_id, device_name, receive_internals
     FROM devices WHERE sync_token = ? AND revoked = 0`
  )
    .bind(token)
    .first<DeviceRow>();

  if (!row) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Update last_seen_at (fire-and-forget)
  c.env.DB.prepare(
    `UPDATE devices SET last_seen_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), row.id)
    .run()
    .catch(() => {});

  c.set("device", {
    id: row.id,
    vaultId: row.vault_id,
    deviceName: row.device_name,
    receiveInternals: row.receive_internals === 1,
  });

  await next();
};
