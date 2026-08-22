import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { requireDevice } from "../middleware/syncAuth";
import {
  isOsJunk,
  isValidSyncPath,
  isVaultInternal,
} from "../vault/path";
import { isTextContentType, type ResolveConflictRequest } from "../vault/contracts";
import { contentTypeForUpload } from "../vault/mime";
import type { ConflictPolicy } from "../devices/types";
import type { BatchOpResult, BatchSyncRequest, BatchSyncResponse } from "./journal";

const syncRoutes = new Hono<{ Bindings: Env }>();
const SAFE_DO_RPC_UPLOAD_BYTES = 24 * 1024 * 1024;

function extractFilePath(url: URL, vaultId: string): string {
  const prefix = `/api/sync/${vaultId}/files/`;
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

function stubFor(env: Env, vaultId: string) {
  return env.VAULT_COORDINATOR.get(env.VAULT_COORDINATOR.idFromName(vaultId));
}

async function syncPutBytes(
  env: Env,
  vaultId: string,
  path: string,
  body: ArrayBuffer,
  contentType: string,
  baseRevision: number | undefined,
  author: string,
  conflictPolicy: ConflictPolicy,
  allowInternals: boolean
) {
  const stub = stubFor(env, vaultId);
  if (isTextContentType(contentType) && body.byteLength <= SAFE_DO_RPC_UPLOAD_BYTES) {
    return stub.syncPutFile(
      vaultId,
      path,
      body,
      contentType,
      baseRevision,
      author,
      conflictPolicy,
      allowInternals
    );
  }

  const stagingKey = `${vaultId}/_staging/${crypto.randomUUID()}`;
  await env.VAULT_BUCKET.put(stagingKey, body, {
    httpMetadata: { contentType },
  });
  try {
    return await stub.syncPutStagedFile(
      vaultId,
      path,
      stagingKey,
      contentType,
      baseRevision,
      author,
      conflictPolicy,
      allowInternals
    );
  } catch (error) {
    await env.VAULT_BUCKET.delete(stagingKey);
    throw error;
  }
}

function staleResponse(c: Context, err: { message?: string; serverRevision?: number; headRevision?: number }) {
  const headRevision = err.headRevision ?? err.serverRevision;
  return c.json({ error: err.message ?? "Revision conflict", headRevision, serverRevision: headRevision }, 409);
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

syncRoutes.get("/:vaultId/manifest", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);
  const manifest = await stubFor(c.env, vaultId).getManifest(vaultId);
  if (device.receiveInternals) return c.json(manifest);
  return c.json({
    ...manifest,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).filter(
        ([, entry]) => !isVaultInternal(entry.path)
      )
    ),
  });
});

syncRoutes.post("/:vaultId/acks", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  let body: { acks?: Array<{ path?: string; revision?: number }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const acks = (body.acks ?? []).filter(
    (ack): ack is { path: string; revision: number } =>
      typeof ack.path === "string" && typeof ack.revision === "number"
  );
  try {
    return c.json(
      await stubFor(c.env, vaultId).recordAcks(vaultId, device.author, { acks })
    );
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

syncRoutes.get("/:vaultId/conflicts", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);
  const conflicts = await stubFor(c.env, vaultId).listConflicts(vaultId);
  return c.json({
    conflicts: device.receiveInternals
      ? conflicts
      : conflicts.filter((conflict) => !isVaultInternal(conflict.path)),
  });
});

syncRoutes.post("/:vaultId/conflicts/resolve", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  let body: Partial<ResolveConflictRequest>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (
    typeof body.path !== "string" ||
    typeof body.conflictNote !== "string" ||
    (body.action !== "keep-server" &&
      body.action !== "keep-client" &&
      body.action !== "use-merged") ||
    (body.action !== "keep-server" && typeof body.content !== "string")
  ) {
    return c.json({ error: "Invalid conflict resolution request" }, 400);
  }

  try {
    return c.json(
      await stubFor(c.env, vaultId).resolveConflict(
        vaultId,
        body as ResolveConflictRequest,
        device.author,
        device.receiveInternals
      )
    );
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    return c.json(
      { error: err.message ?? "Failed" },
      (err.status ?? 500) as 400 | 404 | 500
    );
  }
});

syncRoutes.get("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (isVaultInternal(filePath) && !device.receiveInternals) {
    return c.json({ error: "Not found" }, 404);
  }

  const content = await stubFor(c.env, vaultId).fetch(
    new Request(
      `https://do-internal/content?vaultId=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(filePath)}`
    )
  );
  if (content.status === 404) return c.json({ error: "Not found" }, 404);
  const headers = new Headers(content.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(content.body, { status: content.status, headers });
});

syncRoutes.put("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const filePath = extractFilePath(new URL(c.req.url), vaultId);
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidSyncPath(filePath, device.receiveInternals)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  if (isOsJunk(filePath)) return c.json({ error: "OS junk files are not accepted" }, 400);

  const baseRevisionHeader = c.req.header("X-Base-Revision");
  const baseRevision = baseRevisionHeader !== undefined ? parseInt(baseRevisionHeader, 10) : undefined;
  const body = await c.req.arrayBuffer();
  const contentType = contentTypeForUpload(
    filePath,
    c.req.header("Content-Type")
  );

  try {
    const entry = await syncPutBytes(
      c.env,
      vaultId,
      filePath,
      body,
      contentType,
      baseRevision,
      device.author,
      device.conflictPolicy,
      device.receiveInternals
    );
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; serverRevision?: number; headRevision?: number };
    if (err.status === 409) return staleResponse(c, err);
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 409 | 500);
  }
});

syncRoutes.post("/:vaultId/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const url = new URL(c.req.url);
  const prefix = `/api/sync/${vaultId}/files/`;
  let rawPath = decodeURIComponent(url.pathname.slice(prefix.length));
  if (rawPath.endsWith("/patch")) rawPath = rawPath.slice(0, -"/patch".length);

  const filePath = rawPath;
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidSyncPath(filePath, device.receiveInternals)) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const body = await c.req.json<{ patch: string; baseRevision: number }>();
  if (typeof body.patch !== "string" || typeof body.baseRevision !== "number") {
    return c.json({ error: "patch (string) and baseRevision (number) are required" }, 400);
  }

  try {
    const entry = await stubFor(c.env, vaultId).syncApplyPatch(
      vaultId,
      filePath,
      body.patch,
      body.baseRevision,
      device.author,
      device.conflictPolicy,
      device.receiveInternals
    );
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; serverRevision?: number; headRevision?: number };
    if (err.status === 409) return staleResponse(c, err);
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 404 | 409 | 422 | 500);
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
    const entry = await stubFor(c.env, vaultId).syncRenameFile(
      vaultId,
      filePath,
      newPath,
      device.author,
      device.receiveInternals
    );
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
  if (!isValidSyncPath(filePath, device.receiveInternals)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  try {
    await stubFor(c.env, vaultId).syncDeleteFile(
      vaultId,
      filePath,
      device.author,
      device.receiveInternals
    );
    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

syncRoutes.post("/:vaultId/batch", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  let body: BatchSyncRequest;
  try {
    body = await c.req.json<BatchSyncRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.ops)) return c.json({ error: "ops must be an array" }, 400);

  const stub = stubFor(c.env, vaultId);
  const results: BatchOpResult[] = [];

  for (const op of body.ops) {
    const path = op.op === "rename" ? op.oldPath : op.path;
    try {
      if (op.op === "put") {
        const bin = atob(op.contentBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const entry = await syncPutBytes(
          c.env,
          vaultId,
          path,
          bytes.buffer,
          contentTypeForUpload(path, op.contentType),
          op.baseRevision,
          device.author,
          device.conflictPolicy,
          device.receiveInternals
        );
        results.push({ op: "put", path, status: "accepted", entry: entry as unknown as Record<string, unknown> });
      } else if (op.op === "patch") {
        const entry = await stub.syncApplyPatch(
          vaultId,
          path,
          op.patch,
          op.baseRevision,
          device.author,
          device.conflictPolicy,
          device.receiveInternals
        );
        results.push({ op: "patch", path, status: "accepted", entry: entry as unknown as Record<string, unknown> });
      } else if (op.op === "rename") {
        const entry = await stub.syncRenameFile(
          vaultId,
          op.oldPath,
          op.newPath,
          device.author,
          device.receiveInternals
        );
        results.push({ op: "rename", path: op.oldPath, status: "accepted", entry: entry as unknown as Record<string, unknown> });
      } else if (op.op === "delete") {
        await stub.syncDeleteFile(
          vaultId,
          path,
          device.author,
          device.receiveInternals
        );
        results.push({ op: "delete", path, status: "accepted" });
      }
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string; serverRevision?: number; headRevision?: number };
      results.push({
        op: op.op as BatchOpResult["op"],
        path,
        status: err.status === 409 ? "stale" : "error",
        error: err.message ?? "Failed",
        headRevision: err.headRevision ?? err.serverRevision,
      });
    }
  }

  const response: BatchSyncResponse = { results };
  return c.json(response, 200);
});

syncRoutes.put("/:vaultId/seed/files/*", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  const url = new URL(c.req.url);
  const prefix = `/api/sync/${vaultId}/seed/files/`;
  const filePath = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (isOsJunk(filePath)) return new Response(null, { status: 204 });

  if (isVaultInternal(filePath) && !device.receiveInternals) {
    return new Response(null, { status: 204 });
  }
  if (!isValidSyncPath(filePath, device.receiveInternals)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  const body = await c.req.arrayBuffer();
  const contentType = contentTypeForUpload(
    filePath,
    c.req.header("Content-Type")
  );
  try {
    const entry = await syncPutBytes(
      c.env,
      vaultId,
      filePath,
      body,
      contentType,
      undefined,
      device.author,
      device.conflictPolicy,
      device.receiveInternals
    );
    return c.json(entry, 200);
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    console.error(`[lapis] Seed upload failed for vault ${vaultId}, path ${filePath}:`, error);
    return c.json(
      { error: err.message ?? "Seed upload failed" },
      (err.status ?? 500) as 400 | 409 | 500
    );
  }
});

syncRoutes.post("/:vaultId/seed/complete", requireDevice, async (c) => {
  const device = c.get("device");
  const { vaultId } = c.req.param();
  if (device.vaultId !== vaultId) return c.json({ error: "Forbidden" }, 403);

  try {
    const result = await stubFor(c.env, vaultId).sealNow(`seed by ${device.deviceName}`);
    return c.json({ ok: true, commitHash: result.commitHash, fileCount: result.fileCount, remote: result.remote });
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? "Seal failed";
    console.error(`[lapis] Seed seal failed for vault ${vaultId}:`, err);
    return c.json({ error: msg }, 500);
  }
});

export { syncRoutes };
