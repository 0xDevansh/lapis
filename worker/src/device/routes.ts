/**
 * Device-code plugin connection flow — Slice 07.
 *
 * Flow:
 *   1. Plugin: POST /api/device-auth/request  { vaultId, deviceName }
 *      ← { deviceCode, userCode, verificationUri, expiresIn }
 *   2. Plugin: polls POST /api/device-auth/token  { deviceCode }
 *      ← 202 { status: 'pending' } | 200 { token, deviceId } | 400 { error: 'denied'|'expired' }
 *   3. Vault Owner: GET /api/vaults/:id/devices/pending  → pending user codes
 *   4. Vault Owner: POST /api/vaults/:id/devices/approve  { userCode }
 *      ← Device created, poll resolves with token
 *   5. Plugin uses Authorization: Bearer <token> for all sync requests
 *
 * Device management (authenticated as vault owner):
 *   GET    /api/vaults/:id/devices
 *   DELETE /api/vaults/:id/devices/:deviceId   (revoke)
 *   PATCH  /api/vaults/:id/devices/:deviceId   { receiveInternals: boolean }
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { createAgentDevice, createPluginDevice } from "../devices/record";

const deviceRoutes = new Hono<{ Bindings: Env }>();

// ── Device-code request (unauthenticated — plugin calls this) ─────────────────

/**
 * POST /api/device-auth/request
 * Body: { vaultId: string, deviceName: string }
 *
 * Creates a pending device-code flow for a vault.
 * The vault must exist; the plugin identifies it by ID.
 */
deviceRoutes.post("/device-auth/request", async (c) => {
  const body = await c.req.json<{ vaultId?: string; deviceName?: string }>();
  const vaultId = (body.vaultId ?? "").trim();
  const deviceName = (body.deviceName ?? "").trim();

  if (!vaultId || !deviceName) {
    return c.json({ error: "vaultId and deviceName are required" }, 400);
  }

  // Verify vault exists
  const vault = await c.env.DB.prepare(
    `SELECT id, owner_id FROM vaults WHERE id = ?`
  ).bind(vaultId).first<{ id: string; owner_id: string }>();
  if (!vault) return c.json({ error: "Vault not found" }, 404);

  const deviceCode = generateSecret(32);
  const userCode = generateUserCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  await c.env.DB.prepare(
    `INSERT INTO device_codes (device_code, user_code, vault_id, owner_id, device_name, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(deviceCode, userCode, vaultId, vault.owner_id, deviceName, expiresAt, now).run();

  return c.json({
    deviceCode,
    userCode,
    verificationUri: `/vault/${vaultId}/devices`,
    expiresIn: 600,
  });
});

// ── Token poll (unauthenticated — plugin calls this) ──────────────────────────

/**
 * POST /api/device-auth/token
 * Body: { deviceCode: string }
 *
 * Returns:
 *   - 202 { status: "pending" }  — not yet approved
 *   - 200 { token: string, deviceId: string } — approved; plugin should store this
 *   - 400 { error: "denied" }    — denied by owner
 *   - 400 { error: "expired" }   — flow expired
 *   - 400 { error: "not_found" } — unknown device code
 */
deviceRoutes.post("/device-auth/token", async (c) => {
  const body = await c.req.json<{ deviceCode?: string }>();
  const deviceCode = (body.deviceCode ?? "").trim();
  if (!deviceCode) return c.json({ error: "deviceCode is required" }, 400);

  type DeviceCodeRow = {
    device_code: string;
    user_code: string;
    vault_id: string;
    owner_id: string;
    device_name: string;
    status: string;
    expires_at: string;
  };

  const row = await c.env.DB.prepare(
    `SELECT device_code, user_code, vault_id, owner_id, device_name, status, expires_at
     FROM device_codes WHERE device_code = ?`
  ).bind(deviceCode).first<DeviceCodeRow>();

  if (!row) return c.json({ error: "not_found" }, 400);

  if (row.status === "denied") {
    await c.env.DB.prepare(`DELETE FROM device_codes WHERE device_code = ?`)
      .bind(deviceCode).run();
    return c.json({ error: "denied" }, 400);
  }

  if (new Date(row.expires_at) < new Date()) {
    await c.env.DB.prepare(`DELETE FROM device_codes WHERE device_code = ?`)
      .bind(deviceCode).run();
    return c.json({ error: "expired" }, 400);
  }

  if (row.status === "pending") {
    return c.json({ status: "pending" }, 202);
  }

  // status === "approved" — create device record and return token
  if (row.status === "approved") {
    // Check if device was already created (idempotent poll)
    type DeviceRow = { id: string; sync_token: string };
    const existing = await c.env.DB.prepare(
      `SELECT id, sync_token FROM devices WHERE vault_id = ? AND device_name = ? AND revoked = 0`
    ).bind(row.vault_id, row.device_name).first<DeviceRow>();

    if (existing) {
      await c.env.DB.prepare(`DELETE FROM device_codes WHERE device_code = ?`)
        .bind(deviceCode).run();
      return c.json({ token: existing.sync_token, deviceId: existing.id });
    }

    const deviceId = crypto.randomUUID();
    const syncToken = generateSecret(40);
    await createPluginDevice(c.env.DB, {
      id: deviceId,
      vaultId: row.vault_id,
      ownerId: row.owner_id,
      deviceName: row.device_name,
      syncToken,
    });

    await c.env.DB.prepare(`DELETE FROM device_codes WHERE device_code = ?`)
      .bind(deviceCode).run();

    return c.json({ token: syncToken, deviceId });
  }

  return c.json({ error: "not_found" }, 400);
});

// ── Pending codes (vault owner approves from web) ─────────────────────────────

interface PendingDevice {
  userCode: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * GET /api/vaults/:id/devices/pending
 * Returns device-code flows awaiting approval for this vault.
 */
deviceRoutes.get("/vaults/:id/devices/pending", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  // Clean up expired codes
  await c.env.DB.prepare(
    `DELETE FROM device_codes WHERE expires_at < ? AND vault_id = ?`
  ).bind(new Date().toISOString(), id).run();

  const { results } = await c.env.DB.prepare(
    `SELECT user_code AS userCode, device_name AS deviceName, created_at AS createdAt, expires_at AS expiresAt
     FROM device_codes
     WHERE vault_id = ? AND status = 'pending'
     ORDER BY created_at DESC`
  ).bind(id).all<PendingDevice>();

  return c.json(results ?? []);
});

/**
 * POST /api/vaults/:id/devices/approve
 * Body: { userCode: string }
 * Approves a pending device-code flow.
 */
deviceRoutes.post("/vaults/:id/devices/approve", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ userCode?: string }>();
  const userCode = (body.userCode ?? "").trim().toUpperCase();
  if (!userCode) return c.json({ error: "userCode is required" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT device_code, expires_at FROM device_codes
     WHERE vault_id = ? AND user_code = ? AND status = 'pending'`
  ).bind(id, userCode).first<{ device_code: string; expires_at: string }>();

  if (!row) return c.json({ error: "Code not found or already used" }, 404);
  if (new Date(row.expires_at) < new Date()) {
    await c.env.DB.prepare(`DELETE FROM device_codes WHERE device_code = ?`)
      .bind(row.device_code).run();
    return c.json({ error: "Code expired" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE device_codes SET status = 'approved' WHERE device_code = ?`
  ).bind(row.device_code).run();

  return c.json({ ok: true });
});

/**
 * POST /api/vaults/:id/devices/deny
 * Body: { userCode: string }
 * Denies a pending device-code flow.
 */
deviceRoutes.post("/vaults/:id/devices/deny", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ userCode?: string }>();
  const userCode = (body.userCode ?? "").trim().toUpperCase();
  if (!userCode) return c.json({ error: "userCode is required" }, 400);

  await c.env.DB.prepare(
    `UPDATE device_codes SET status = 'denied'
     WHERE vault_id = ? AND user_code = ? AND status = 'pending'`
  ).bind(id, userCode).run();

  return c.json({ ok: true });
});

// ── Device management ─────────────────────────────────────────────────────────

export interface Device {
  id: string;
  deviceName: string;
  kind: string;
  receiveInternals: boolean;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  capabilities?: Record<string, unknown>;
  conflictPolicy?: string;
}

/**
 * GET /api/vaults/:id/devices
 * Returns all connected (non-revoked) devices for the vault.
 */
deviceRoutes.get("/vaults/:id/devices", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, device_name AS deviceName, kind,
            receive_internals AS receiveInternals,
            capabilities,
            conflict_policy AS conflictPolicy,
            revoked,
            created_at AS createdAt,
            last_seen_at AS lastSeenAt
     FROM devices
     WHERE vault_id = ? AND revoked = 0
     ORDER BY created_at DESC`
  ).bind(id).all<Device>();

  // D1 returns booleans as 0/1 integers
  const mapped = (results ?? []).map((d) => ({
    ...d,
    receiveInternals: Boolean(d.receiveInternals),
    revoked: Boolean(d.revoked),
    capabilities: d.capabilities ? (() => { try { return JSON.parse(String(d.capabilities)); } catch { return undefined; } })() : undefined,
  }));

  return c.json(mapped);
});

/**
 * POST /api/vaults/:id/agents
 * Mint a first-class agent device (Slice 24). Token shown once.
 */
deviceRoutes.post("/vaults/:id/agents", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "Agent").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const agentId = crypto.randomUUID();
  const syncToken = generateSecret(40);
  const { record } = await createAgentDevice(c.env.DB, {
    id: agentId,
    vaultId: id,
    ownerId: session.userId,
    name,
    syncToken,
  });

  return c.json({ agentId: record.id, token: syncToken, name: record.deviceName });
});

/**
 * DELETE /api/vaults/:id/devices/:deviceId
 * Revoke a device. Revoked devices can no longer sync.
 */
deviceRoutes.delete("/vaults/:id/devices/:deviceId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, deviceId } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  await c.env.DB.prepare(
    `UPDATE devices SET revoked = 1 WHERE id = ? AND vault_id = ?`
  ).bind(deviceId, id).run();

  return c.json({ ok: true });
});

/**
 * PATCH /api/vaults/:id/devices/:deviceId
 * Body: { receiveInternals: boolean }
 * Toggle whether this device should receive Vault Internals updates.
 */
deviceRoutes.patch("/vaults/:id/devices/:deviceId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, deviceId } = c.req.param();

  const owned = await verifyVaultOwner(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ receiveInternals?: boolean }>();
  const receiveInternals = body.receiveInternals === true ? 1 : 0;

  await c.env.DB.prepare(
    `UPDATE devices SET receive_internals = ? WHERE id = ? AND vault_id = ?`
  ).bind(receiveInternals, deviceId, id).run();

  return c.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyVaultOwner(
  db: D1Database,
  vaultId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM vaults WHERE id = ? AND owner_id = ?`)
    .bind(vaultId, userId)
    .first<{ id: string }>();
  return row !== null;
}

/** Generate a cryptographically random hex string of given byte length. */
function generateSecret(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a short human-readable user code in the format XXXX-XXXX.
 * Uses uppercase letters excluding easily confused characters.
 */
function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += chars[arr[i] % chars.length];
  }
  return code;
}

export { deviceRoutes };
