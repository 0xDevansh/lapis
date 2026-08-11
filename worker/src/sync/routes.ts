import { Hono } from "hono";
import type { Env } from "../types";
import { requireDevice } from "../middleware/syncAuth";
import { isOsJunk, isValidVaultPath, isVaultInternal } from "../vault/path";

/**
 * Device-auth sync surface — Yjs for text, REST only for binary blobs + listing.
 * No patch/batch/seed/revision protocol.
 */
const syncRoutes = new Hono<{ Bindings: Env }>();

function extractFilePath(url: URL, vaultId: string): string {
  const prefix = `/api/sync/${vaultId}/files/`;
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

function detectMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    json: "application/json",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

function stubFor(env: Env, vaultId: string) {
  return env.VAULT_COORDINATOR.get(env.VAULT_COORDINATOR.idFromName(vaultId));
}

syncRoutes.patch("/:vaultId/device", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ receiveInternals?: boolean }>();
  const receiveInternals = body.receiveInternals === true ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE devices SET receive_internals = ? WHERE id = ? AND vault_id = ?`
  ).bind(receiveInternals, device.id, vaultId).run();

  return c.json({ ok: true, deviceId: device.id, receiveInternals: receiveInternals === 1 });
});

/** Derived listing from Y.Doc (convenience; clients should prefer Yjs maps). */
syncRoutes.get("/:vaultId/manifest", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);
  return c.json(await stubFor(c.env, vaultId).getManifest(vaultId));
});

/** Binary (and legacy text) download — text prefers Yjs on clients. */
syncRoutes.get("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Not found" }, 404);

  const content = await stubFor(c.env, vaultId).getContent(vaultId, filePath);
  if (!content) return c.json({ error: "Not found" }, 404);
  return new Response(content.bytes, {
    headers: {
      "Content-Type": content.contentType,
      "Cache-Control": "no-store",
      "Content-Length": String(content.bytes.byteLength),
    },
  });
});

/**
 * Binary upload into R2 + Yjs meta. Text bodies are accepted for agents/tools
 * but write through Yjs (whole-file replace); prefer the /yjs WebSocket.
 */
syncRoutes.put("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidVaultPath(filePath)) return c.json({ error: "Invalid path" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Cannot write to vault internals" }, 400);
  if (isOsJunk(filePath)) return c.json({ error: "OS junk files are not accepted" }, 400);

  const body = await c.req.arrayBuffer();
  const contentType = (c.req.header("Content-Type") ?? detectMime(filePath)).split(";")[0].trim();

  try {
    const entry = await stubFor(c.env, vaultId).syncPutFile(
      vaultId,
      filePath,
      body,
      contentType,
      device.author
    );
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 409 | 500);
  }
});

syncRoutes.patch("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  const body = await c.req.json<{ newPath?: string }>();
  const newPath = (body.newPath ?? "").trim();
  if (!newPath) return c.json({ error: "newPath is required" }, 400);

  try {
    const entry = await stubFor(c.env, vaultId).syncRenameFile(vaultId, filePath, newPath, device.author);
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 404 | 409 | 500);
  }
});

syncRoutes.delete("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  try {
    await stubFor(c.env, vaultId).syncDeleteFile(vaultId, filePath, device.author);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

/** GET /api/sync/:vaultId/yjs — device-auth Yjs WebSocket */
syncRoutes.get("/:vaultId/yjs", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const stub = stubFor(c.env, vaultId);
  const url = new URL("https://do/yjs");
  url.searchParams.set("write", "1");
  url.searchParams.set("vaultId", vaultId);
  return stub.fetch(new Request(url.toString(), { headers: { Upgrade: "websocket" } }));
});

export { syncRoutes };
