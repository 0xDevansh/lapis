/**
 * Device D1 query helpers — Slice 23.
 */

import type { DeviceKind } from "../vault/identity";
import {
  capabilitiesToJson,
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_PLUGIN_CAPABILITIES,
  identityFromRecord,
  parseCapabilitiesJson,
  type ConflictPolicy,
  type DeviceCapabilities,
  type DeviceRecord,
} from "./types";

type DeviceRow = {
  id: string;
  vault_id: string;
  owner_id: string;
  device_name: string;
  kind: string;
  capabilities: string | null;
  conflict_policy: string;
  sync_cursor: string | null;
  receive_internals: number;
  revoked: number;
  created_at: string;
  last_seen_at: string | null;
};

function rowToRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    vaultId: row.vault_id,
    ownerId: row.owner_id,
    deviceName: row.device_name,
    kind: (row.kind || "plugin") as DeviceKind,
    capabilities: parseCapabilitiesJson(row.capabilities),
    conflictPolicy: (row.conflict_policy || "rebase") as ConflictPolicy,
    syncCursor: row.sync_cursor,
    receiveInternals: row.receive_internals === 1,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

const DEVICE_COLUMNS = `id, vault_id, owner_id, device_name, kind, capabilities,
  conflict_policy, sync_cursor, receive_internals, revoked, created_at, last_seen_at`;

export async function getDeviceByToken(db: D1Database, token: string): Promise<DeviceRecord | null> {
  const row = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE sync_token = ? AND revoked = 0`)
    .bind(token)
    .first<DeviceRow>();
  return row ? rowToRecord(row) : null;
}

export async function listVaultDevices(db: D1Database, vaultId: string): Promise<DeviceRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE vault_id = ? AND revoked = 0 ORDER BY created_at DESC`)
    .bind(vaultId)
    .all<DeviceRow>();
  return (results ?? []).map(rowToRecord);
}

export async function createPluginDevice(
  db: D1Database,
  input: { id: string; vaultId: string; ownerId: string; deviceName: string; syncToken: string }
): Promise<DeviceRecord> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO devices
       (id, vault_id, owner_id, device_name, sync_token, kind, capabilities, conflict_policy,
        receive_internals, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, 'plugin', ?, 'rebase', 0, 0, ?)`
    )
    .bind(
      input.id,
      input.vaultId,
      input.ownerId,
      input.deviceName,
      input.syncToken,
      capabilitiesToJson(DEFAULT_PLUGIN_CAPABILITIES),
      now
    )
    .run();
  const record = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ?`)
    .bind(input.id)
    .first<DeviceRow>();
  if (!record) throw new Error("Failed to create device");
  return rowToRecord(record);
}

export async function createAgentDevice(
  db: D1Database,
  input: { id: string; vaultId: string; ownerId: string; name: string; syncToken: string }
): Promise<{ record: DeviceRecord; token: string }> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO devices
       (id, vault_id, owner_id, device_name, sync_token, kind, capabilities, conflict_policy,
        receive_internals, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, 'agent', ?, 'conflict-note', 0, 0, ?)`
    )
    .bind(
      input.id,
      input.vaultId,
      input.ownerId,
      input.name,
      input.syncToken,
      capabilitiesToJson(DEFAULT_AGENT_CAPABILITIES),
      now
    )
    .run();
  const record = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ?`)
    .bind(input.id)
    .first<DeviceRow>();
  if (!record) throw new Error("Failed to create agent device");
  return { record: rowToRecord(record), token: input.syncToken };
}

export { identityFromRecord };
