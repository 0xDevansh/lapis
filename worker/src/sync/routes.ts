/**
 * Plugin sync API — Slice 09.
 *
 * These routes are authenticated with a device sync token (`requireDevice`).
 * They provide the server side of the two-way sync protocol used by the
 * Obsidian plugin (and any other Local Vault client).
 *
 * All endpoints scope their access to the vault that issued the device's token.
 * Vault Internals and OS junk are blocked on inbound writes.
 *
 * Routes:
 *   GET  /api/sync/:vaultId/manifest            — pull full manifest (for diff/scan)
 *   GET  /api/sync/:vaultId/files/*             — pull a single file's content
 *   PUT  /api/sync/:vaultId/files/*             — push whole-object (binary or new text)
 *   POST /api/sync/:vaultId/files/{path}/patch  — push text patch (unified diff)
 *   PATCH  /api/sync/:vaultId/files/*           — rename/move
 *   DELETE /api/sync/:vaultId/files/*           — delete
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireDevice } from "../middleware/syncAuth";
import { isValidVaultPath, isVaultInternal, isOsJunk } from "../vault/path";
import { contentKey } from "../vault/manifest";
import { indexFile, removeFromIndex, renameInIndex } from "../search/indexer";

const syncRoutes = new Hono<{ Bindings: Env }>();

// ── Helper: extract path after the fixed prefix ────────────────────────────

function extractFilePath(url: URL, vaultId: string): string {
  const prefix = `/api/sync/${vaultId}/files/`;
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

// ── Detect MIME from extension (shared with vault routes) ──────────────────

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

// ── GET /api/sync/:vaultId/manifest ───────────────────────────────────────
// Returns the current vault manifest (including revision numbers).
// Device must belong to the requested vaultId.

syncRoutes.get("/:vaultId/manifest", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const manifest = await stub.getManifest(vaultId);

  return c.json(manifest);
});

// ── GET /api/sync/:vaultId/files/* ────────────────────────────────────────
// Pull a single file from the Web Vault (web→local direction).
// Vault Internals are blocked.

syncRoutes.get("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);

  if (isVaultInternal(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }

  const r2Key = contentKey(vaultId, filePath);
  const obj = await c.env.VAULT_BUCKET.get(r2Key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Length": String(obj.size),
    },
  });
});

// ── PUT /api/sync/:vaultId/files/* ────────────────────────────────────────
// Push a whole-object file (new file or binary update).
//
// Body: raw bytes. Caller must set Content-Type.
// Optional header: X-Base-Revision: <number>
//   If provided, the server checks the current revision matches before writing.
//   If mismatched, returns 409 with { error, serverRevision }.
//
// Vault Internals and OS junk are blocked.

syncRoutes.put("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidVaultPath(filePath)) return c.json({ error: "Invalid path" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Cannot write to vault internals" }, 400);
  if (isOsJunk(filePath)) return c.json({ error: "OS junk files are not accepted" }, 400);

  const baseRevisionHeader = c.req.header("X-Base-Revision");
  const baseRevision = baseRevisionHeader !== undefined ? parseInt(baseRevisionHeader, 10) : undefined;

  const body = await c.req.arrayBuffer();
  const contentType = (c.req.header("Content-Type") ?? detectMime(filePath)).split(";")[0].trim();

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    const entry = await stub.syncPutFile(vaultId, filePath, body, contentType, baseRevision);

    // Update search index (fire-and-forget)
    if (contentType.startsWith("text/") || contentType === "application/json") {
      try {
        const text = new TextDecoder().decode(body);
        const manifest = await stub.getManifest(vaultId);
        const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
        indexFile(c.env.DB, { vaultId, path: filePath, content: text, vaultPaths }).catch(() => {});
      } catch { /* ignore indexing errors */ }
    }

    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; serverRevision?: number };
    if (err.status === 409 && err.serverRevision !== undefined) {
      return c.json({ error: err.message, serverRevision: err.serverRevision }, 409);
    }
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 409 | 500);
  }
});

// ── POST /api/sync/:vaultId/files/*/patch ────────────────────────────────
// Push a unified diff patch for a text file.
//
// Body: JSON { patch: string, baseRevision: number }
//   - patch: unified diff string (--- a/... +++ b/... hunks)
//   - baseRevision: the revision the patch was produced from
//
// Returns 409 if server revision !== baseRevision (stale).
// Returns 422 if the patch does not apply cleanly.
//
// NOTE: The route uses a suffix `/patch` to avoid conflicting with the file
// path wildcard — it must be registered before `/:vaultId/files/*`.

syncRoutes.post("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // The path from the URL includes a trailing `/patch` suffix that the plugin
  // appends. Strip it to get the vault-relative file path.
  const url = new URL(c.req.url);
  const prefix = `/api/sync/${vaultId}/files/`;
  let rawPath = decodeURIComponent(url.pathname.slice(prefix.length));
  if (rawPath.endsWith("/patch")) {
    rawPath = rawPath.slice(0, -"/patch".length);
  }

  const filePath = rawPath;
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidVaultPath(filePath)) return c.json({ error: "Invalid path" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Cannot write to vault internals" }, 400);

  const body = await c.req.json<{ patch: string; baseRevision: number }>();
  if (typeof body.patch !== "string" || typeof body.baseRevision !== "number") {
    return c.json({ error: "patch (string) and baseRevision (number) are required" }, 400);
  }

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    const entry = await stub.syncApplyPatch(vaultId, filePath, body.patch, body.baseRevision);

    // Update search index (fire-and-forget)
    try {
      const r2Key = contentKey(vaultId, filePath);
      const obj = await c.env.VAULT_BUCKET.get(r2Key);
      if (obj) {
        const text = await obj.text();
        const manifest = await stub.getManifest(vaultId);
        const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
        indexFile(c.env.DB, { vaultId, path: filePath, content: text, vaultPaths }).catch(() => {});
      }
    } catch { /* ignore */ }

    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; serverRevision?: number };
    if (err.status === 409 && err.serverRevision !== undefined) {
      return c.json({ error: err.message, serverRevision: err.serverRevision }, 409);
    }
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 404 | 409 | 422 | 500);
  }
});

// ── PATCH /api/sync/:vaultId/files/* ─────────────────────────────────────
// Rename or move a file.
// Body: { newPath: string }

syncRoutes.patch("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);

  const body = await c.req.json<{ newPath?: string }>();
  const newPath = (body.newPath ?? "").trim();
  if (!newPath) return c.json({ error: "newPath is required" }, 400);

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    const entry = await stub.syncRenameFile(vaultId, filePath, newPath);

    // Update search index
    let newContent: string | undefined;
    if (entry.contentType.startsWith("text/") || entry.contentType === "application/json") {
      try {
        const r2Key = contentKey(vaultId, newPath);
        const obj = await c.env.VAULT_BUCKET.get(r2Key);
        if (obj) newContent = await obj.text();
      } catch { /* ignore */ }
    }
    const manifest = await stub.getManifest(vaultId);
    const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
    renameInIndex(c.env.DB, vaultId, filePath, newPath, newContent, vaultPaths).catch(() => {});

    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 404 | 409 | 500);
  }
});

// ── DELETE /api/sync/:vaultId/files/* ─────────────────────────────────────
// Delete a file from the Web Vault.

syncRoutes.delete("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    await stub.syncDeleteFile(vaultId, filePath);
    removeFromIndex(c.env.DB, vaultId, filePath).catch(() => {});
    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

export { syncRoutes };
