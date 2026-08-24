/**
 * WebSocket notification routes — Slice 10.
 *
 * Two upgrade endpoints:
 *
 * 1. GET /api/vaults/:id/notify        (session cookie auth)
 *    Web browser connects here to receive live vault change notifications.
 *
 * 2. GET /api/sync/:vaultId/notify     (device Bearer token auth)
 *    Plugin connects here to receive change notifications for its vault.
 *
 * Both upgrade the connection and forward it to the VaultCoordinator DO's
 * /ws endpoint, passing an identity string so the DO can track presence.
 *
 * The DO broadcasts small ChangeNotification payloads; clients re-fetch
 * the affected file content via authenticated REST APIs.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { requireDevice } from "../middleware/syncAuth";
import { deviceAuthor } from "../vault/identity";
import { denyAccess, resolveVaultAccess } from "../vault/access";

const notifyRoutes = new Hono<{ Bindings: Env }>();

// ── Helper ─────────────────────────────────────────────────────────────────

function upgradeToWebSocket(
  request: Request,
  vaultId: string,
  identity: string,
  env: Env
): Response {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  // Forward WebSocket upgrade to the VaultCoordinator DO
  const doId = env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = env.VAULT_COORDINATOR.get(doId);

  // Pass identity in the URL so the DO knows who this is
  const wsUrl = `https://do-internal/ws?identity=${encodeURIComponent(identity)}`;
  return stub.fetch(new Request(wsUrl, {
    method: "GET",
    headers: request.headers,
  })) as unknown as Response;
}

// ── GET /api/vaults/:id/notify  (session auth) ─────────────────────────────

notifyRoutes.get("/vaults/:id/notify", requireSession, async (c) => {
  const session = c.get("session");
  const { id: vaultId } = c.req.param();

  const access = await resolveVaultAccess(c.env.DB, vaultId, session.userId);
  const denied = denyAccess(c, access, "read");
  if (denied) return denied;

  const identity = deviceAuthor("web", session.sessionId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return upgradeToWebSocket(c.req.raw, vaultId, identity, c.env) as any;
});

// ── GET /api/sync/:vaultId/notify  (device auth) ───────────────────────────

notifyRoutes.get("/sync/:vaultId/notify", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const identity = deviceAuthor("plugin", device.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return upgradeToWebSocket(c.req.raw, vaultId, identity, c.env) as any;
});

export { notifyRoutes };
