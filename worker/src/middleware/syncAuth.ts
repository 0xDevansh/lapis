/**
 * Sync token authentication middleware — Slice 07 / 23.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getDeviceByToken } from "../devices/record";
import { identityFromRecord, type ConflictPolicy } from "../devices/types";
import type { DeviceKind } from "../vault/identity";

export interface DeviceContext {
  id: string;
  vaultId: string;
  deviceName: string;
  kind: DeviceKind;
  conflictPolicy: ConflictPolicy;
  receiveInternals: boolean;
  author: string;
}

declare module "hono" {
  interface ContextVariableMap {
    device: DeviceContext;
  }
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
  });

  await next();
};
