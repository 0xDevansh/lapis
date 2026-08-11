/**
 * Owner/editor API for vault MCP settings + token minting.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { requireVaultAccess, AccessError } from "../auth/access";
import { createAgentDevice } from "../devices/record";
import { getMcpSettings, putMcpSettings, type VaultMcpSettingsPatch } from "./settings";

const mcpRoutes = new Hono<{ Bindings: Env }>();

function generateSecret(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** GET /api/vaults/:id/mcp — current MCP settings + endpoint URL. */
mcpRoutes.get("/:id/mcp", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { vault: "read" });
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const settings = await getMcpSettings(c.env.DB, id);
  const origin = new URL(c.req.url).origin;
  return c.json({
    ...settings,
    endpoint: `${origin}/api/mcp/${id}`,
  });
});

/** PUT /api/vaults/:id/mcp — update MCP settings. */
mcpRoutes.put("/:id/mcp", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { device: "create" });
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const body = await c.req.json<VaultMcpSettingsPatch>();
  const settings = await putMcpSettings(c.env.DB, id, {
    enabled: body.enabled,
    readOnly: body.readOnly,
    allowPaths: body.allowPaths,
    denyPaths: body.denyPaths,
    allowWrite: body.allowWrite,
    allowSearch: body.allowSearch,
    allowDelete: body.allowDelete,
    maxReadBytes: body.maxReadBytes,
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ ...settings, endpoint: `${origin}/api/mcp/${id}` });
});

/**
 * POST /api/vaults/:id/mcp/tokens
 * Mint an agent device token for MCP clients (shown once).
 */
mcpRoutes.post("/:id/mcp/tokens", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { device: "create" });
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "MCP client").trim() || "MCP client";
  const agentId = crypto.randomUUID();
  const syncToken = generateSecret(40);
  const { record } = await createAgentDevice(c.env.DB, {
    id: agentId,
    vaultId: id,
    ownerId: session.userId,
    name: name.startsWith("MCP") ? name : `MCP · ${name}`,
    syncToken,
  });

  const origin = new URL(c.req.url).origin;
  return c.json({
    tokenId: record.id,
    name: record.deviceName,
    token: syncToken,
    endpoint: `${origin}/api/mcp/${id}`,
  });
});

export { mcpRoutes };
