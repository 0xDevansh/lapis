/**
 * Plugin sync API — Slices 09, 11 & 12.
 *
 * These routes are authenticated with a device sync token (`requireDevice`).
 * They provide the server side of the two-way sync protocol used by the
 * Obsidian plugin (and any other Local Vault client).
 *
 * All endpoints scope their access to the vault that issued the device's token.
 * Vault Internals and OS junk are blocked on inbound writes.
 *
 * Routes:
 *   GET  /api/sync/:vaultId/manifest            — pull full manifest (for diff/scan & reconnect recovery)
 *   GET  /api/sync/:vaultId/files/*             — pull a single file's content
 *   PUT  /api/sync/:vaultId/files/*             — push whole-object (binary or new text)
 *   POST /api/sync/:vaultId/files/{path}/patch  — push text patch (unified diff)
 *   PATCH  /api/sync/:vaultId/files/*           — rename/move
 *   DELETE /api/sync/:vaultId/files/*           — delete
 *   POST /api/sync/:vaultId/batch               — replay ordered journal ops (Slice 12)
 *
 * Slice 11 additions:
 *   PUT  — stale whole-object uploads create a Conflict Note instead of 409.
 *   POST — stale patches attempt three-way merge; on conflict, create a Conflict Note.
 *          Clients may include `clientContent` (and optionally `baseContent`) in the
 *          POST body to enable proper merge3. Without `clientContent`, a conflict note
 *          is created directly.
 *
 * Slice 12 additions:
 *   POST /api/sync/:vaultId/batch — applies an ordered array of PendingOps from the
 *   plugin's local journal. Each op is applied sequentially using the same merge/conflict
 *   logic as individual endpoints. Returns per-op results so the plugin can update its
 *   journal state. Provides atomic ordering guarantees within the DO's single-threaded model.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireDevice } from "../middleware/syncAuth";
import { isValidVaultPath, isVaultInternal, isOsJunk } from "../vault/path";
import { contentKey } from "../vault/manifest";
import { indexFile, removeFromIndex, renameInIndex } from "../search/indexer";
import type { BatchSyncRequest, BatchSyncResponse, BatchOpResult } from "./journal";

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

    // Slice 11: stale whole-object upload → create Conflict Note instead of 409
    if (err.status === 409 && err.serverRevision !== undefined && baseRevision !== undefined) {
      const device = c.get("device");
      try {
        const { conflictPath, entry } = await stub.syncConflictWholeObject(
          vaultId,
          filePath,
          body,
          contentType,
          err.serverRevision,
          baseRevision,
          device.deviceName
        );
        // Index the conflict note
        try {
          const manifest = await stub.getManifest(vaultId);
          const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
          const noteText = new TextDecoder().decode(
            (await c.env.VAULT_BUCKET.get(entry.r2Key))?.body as unknown as ArrayBuffer ?? new ArrayBuffer(0)
          );
          indexFile(c.env.DB, { vaultId, path: conflictPath, content: noteText, vaultPaths }).catch(() => {});
        } catch { /* ignore */ }
        return c.json({ conflict: true, conflictPath, entry }, 202);
      } catch (ce: unknown) {
        const cerr = ce as { status?: number; message?: string };
        return c.json({ error: cerr.message ?? "Failed to create conflict note" }, (cerr.status ?? 500) as 500);
      }
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

  const body = await c.req.json<{
    patch: string;
    baseRevision: number;
    clientContent?: string;  // Slice 11: client's full intended content (enables merge3)
    baseContent?: string;    // Slice 11: common ancestor content (enables proper 3-way merge)
  }>();
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

    // Slice 11: stale patch → attempt three-way merge
    if (err.status === 409 && err.serverRevision !== undefined) {
      const device = c.get("device");

      // If the client provided its full intended content, attempt merge3.
      if (typeof body.clientContent === "string") {
        try {
          const result = await stub.syncMergePatch(
            vaultId,
            filePath,
            body.patch,
            err.serverRevision,
            body.baseRevision,
            device.deviceName,
            body.clientContent,
            body.baseContent
          );

          if (result.kind === "merged") {
            // Clean three-way merge — index and return
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
            return c.json({ merged: true, entry: result.entry }, 200);
          } else {
            // Conflict note created
            try {
              const manifest = await stub.getManifest(vaultId);
              const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
              const r2Key = result.entry.r2Key;
              const obj = await c.env.VAULT_BUCKET.get(r2Key);
              if (obj) {
                const text = await obj.text();
                indexFile(c.env.DB, { vaultId, path: result.conflictPath, content: text, vaultPaths }).catch(() => {});
              }
            } catch { /* ignore */ }
            return c.json({ conflict: true, conflictPath: result.conflictPath, entry: result.entry }, 202);
          }
        } catch (me: unknown) {
          const merr = me as { status?: number; message?: string };
          return c.json({ error: merr.message ?? "Merge failed" }, (merr.status ?? 500) as 400 | 404 | 500);
        }
      }

      // No clientContent provided — return 409 for client to retry with content
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

// ── POST /api/sync/:vaultId/batch ─────────────────────────────────────────
// Replay an ordered list of pending journal operations from a Local Vault.
//
// Body: { ops: PendingOp[] }  (see sync/journal.ts for PendingOp types)
//
// Each op is applied sequentially using the same merge/conflict logic as the
// individual endpoints. The response contains one BatchOpResult per op.
// The plugin uses this to update its local journal after reconnect.
//
// Idempotency: the DO's single-threaded model serialises all ops within the
// batch. Cross-request ordering is the caller's responsibility.

syncRoutes.post("/:vaultId/batch", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();

  if (device.vaultId !== vaultId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let body: BatchSyncRequest;
  try {
    body = await c.req.json<BatchSyncRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.ops)) {
    return c.json({ error: "ops must be an array" }, 400);
  }

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const results: BatchOpResult[] = [];

  for (const op of body.ops) {
    const path = op.op === "rename" ? op.oldPath : op.path;

    try {
      if (op.op === "put") {
        // Decode base64 content
        let bodyBytes: ArrayBuffer;
        try {
          const bin = atob(op.contentBase64);
          bodyBytes = new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i)).buffer;
        } catch {
          results.push({ op: "put", path, status: "error", error: "Invalid base64 content" });
          continue;
        }

        if (!isValidVaultPath(path)) {
          results.push({ op: "put", path, status: "error", error: "Invalid path" });
          continue;
        }
        if (isVaultInternal(path)) {
          results.push({ op: "put", path, status: "error", error: "Vault internals not accepted" });
          continue;
        }
        if (isOsJunk(path)) {
          results.push({ op: "put", path, status: "error", error: "OS junk not accepted" });
          continue;
        }

        try {
          const entry = await stub.syncPutFile(vaultId, path, bodyBytes, op.contentType, op.baseRevision);
          // Index text files
          if (op.contentType.startsWith("text/") || op.contentType === "application/json") {
            try {
              const text = new TextDecoder().decode(bodyBytes);
              const manifest = await stub.getManifest(vaultId);
              const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
              indexFile(c.env.DB, { vaultId, path, content: text, vaultPaths }).catch(() => {});
            } catch { /* ignore */ }
          }
          results.push({ op: "put", path, status: "accepted", entry: entry as unknown as Record<string, unknown> });
        } catch (e: unknown) {
          const err = e as { status?: number; serverRevision?: number };
          if (err.status === 409 && err.serverRevision !== undefined) {
            // Stale → conflict note
            const { conflictPath, entry } = await stub.syncConflictWholeObject(
              vaultId, path, bodyBytes, op.contentType,
              err.serverRevision, op.baseRevision, device.deviceName
            );
            results.push({ op: "put", path, status: "conflict", conflictPath, entry: entry as unknown as Record<string, unknown> });
          } else {
            const msg = (e as { message?: string }).message ?? "Failed";
            results.push({ op: "put", path, status: "error", error: msg });
          }
        }

      } else if (op.op === "patch") {
        if (!isValidVaultPath(path)) {
          results.push({ op: "patch", path, status: "error", error: "Invalid path" });
          continue;
        }
        if (isVaultInternal(path)) {
          results.push({ op: "patch", path, status: "error", error: "Vault internals not accepted" });
          continue;
        }

        try {
          const entry = await stub.syncApplyPatch(vaultId, path, op.patch, op.baseRevision);
          // Index after patch
          try {
            const r2Key = contentKey(vaultId, path);
            const obj = await c.env.VAULT_BUCKET.get(r2Key);
            if (obj) {
              const text = await obj.text();
              const manifest = await stub.getManifest(vaultId);
              const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
              indexFile(c.env.DB, { vaultId, path, content: text, vaultPaths }).catch(() => {});
            }
          } catch { /* ignore */ }
          results.push({ op: "patch", path, status: "accepted", entry: entry as unknown as Record<string, unknown> });
        } catch (e: unknown) {
          const err = e as { status?: number; serverRevision?: number };
          if (err.status === 409 && err.serverRevision !== undefined) {
            // Stale patch → attempt merge3 if clientContent provided
            const mergeResult = await stub.syncMergePatch(
              vaultId, path, op.patch,
              err.serverRevision, op.baseRevision,
              device.deviceName,
              op.clientContent,
              op.baseContent
            );
            if (mergeResult.kind === "merged") {
              // Index the merged result
              try {
                const r2Key = contentKey(vaultId, path);
                const obj = await c.env.VAULT_BUCKET.get(r2Key);
                if (obj) {
                  const text = await obj.text();
                  const manifest = await stub.getManifest(vaultId);
                  const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
                  indexFile(c.env.DB, { vaultId, path, content: text, vaultPaths }).catch(() => {});
                }
              } catch { /* ignore */ }
              results.push({ op: "patch", path, status: "merged", entry: mergeResult.entry as unknown as Record<string, unknown> });
            } else {
              // Index the conflict note
              try {
                const manifest = await stub.getManifest(vaultId);
                const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
                const obj = await c.env.VAULT_BUCKET.get(mergeResult.entry.r2Key);
                if (obj) {
                  const text = await obj.text();
                  indexFile(c.env.DB, { vaultId, path: mergeResult.conflictPath, content: text, vaultPaths }).catch(() => {});
                }
              } catch { /* ignore */ }
              results.push({ op: "patch", path, status: "conflict", conflictPath: mergeResult.conflictPath, entry: mergeResult.entry as unknown as Record<string, unknown> });
            }
          } else {
            const msg = (e as { message?: string }).message ?? "Failed";
            results.push({ op: "patch", path, status: "error", error: msg });
          }
        }

      } else if (op.op === "rename") {
        if (!isValidVaultPath(op.oldPath) || !isValidVaultPath(op.newPath)) {
          results.push({ op: "rename", path: op.oldPath, status: "error", error: "Invalid path" });
          continue;
        }

        try {
          const entry = await stub.syncRenameFile(vaultId, op.oldPath, op.newPath);
          // Update search index
          let newContent: string | undefined;
          if (entry.contentType.startsWith("text/") || entry.contentType === "application/json") {
            try {
              const r2Key = contentKey(vaultId, op.newPath);
              const obj = await c.env.VAULT_BUCKET.get(r2Key);
              if (obj) newContent = await obj.text();
            } catch { /* ignore */ }
          }
          const manifest = await stub.getManifest(vaultId);
          const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
          renameInIndex(c.env.DB, vaultId, op.oldPath, op.newPath, newContent, vaultPaths).catch(() => {});
          results.push({ op: "rename", path: op.oldPath, status: "accepted", entry: entry as unknown as Record<string, unknown> });
        } catch (e: unknown) {
          const msg = (e as { message?: string }).message ?? "Failed";
          results.push({ op: "rename", path: op.oldPath, status: "error", error: msg });
        }

      } else if (op.op === "delete") {
        if (!isValidVaultPath(path)) {
          results.push({ op: "delete", path, status: "error", error: "Invalid path" });
          continue;
        }

        try {
          await stub.syncDeleteFile(vaultId, path);
          removeFromIndex(c.env.DB, vaultId, path).catch(() => {});
          results.push({ op: "delete", path, status: "accepted" });
        } catch (e: unknown) {
          const msg = (e as { message?: string }).message ?? "Failed";
          results.push({ op: "delete", path, status: "error", error: msg });
        }

      } else {
        results.push({ op: (op as { op: string }).op as BatchOpResult["op"], path, status: "error", error: "Unknown op type" });
      }
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? "Unexpected error";
      results.push({ op: op.op as BatchOpResult["op"], path, status: "error", error: msg });
    }
  }

  const response: BatchSyncResponse = { results };
  return c.json(response, 200);
});

export { syncRoutes };
