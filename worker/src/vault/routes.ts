import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { isValidVaultPath, isVaultInternal, isOsJunk } from "./path";
import { deviceAuthor } from "./identity";
import { buildZip, type ZipEntry } from "./zip";
import { isTextContentType, type ResolveConflictRequest } from "./contracts";
import { contentTypeForUpload, detectMimeFromPath } from "./mime";

const vaultRoutes = new Hono<{ Bindings: Env }>();
const SAFE_DO_RPC_UPLOAD_BYTES = 24 * 1024 * 1024;

// ── Helper: resolve vault and verify ownership ─────────────────────────────

async function resolveVault(
  db: D1Database,
  vaultId: string,
  userId: string
): Promise<{ id: string; name: string; createdAt: string } | null> {
  return db
    .prepare(
      `SELECT id, name, created_at AS createdAt FROM vaults WHERE id = ? AND owner_id = ?`
    )
    .bind(vaultId, userId)
    .first<{ id: string; name: string; createdAt: string }>();
}

async function putWebBytes(
  env: Env,
  vaultId: string,
  path: string,
  body: ArrayBuffer,
  contentType: string,
  baseRevision: number | undefined,
  author: string
) {
  const stub = env.VAULT_COORDINATOR.get(
    env.VAULT_COORDINATOR.idFromName(vaultId)
  );
  if (isTextContentType(contentType) && body.byteLength <= SAFE_DO_RPC_UPLOAD_BYTES) {
    return stub.syncPutFile(
      vaultId,
      path,
      body,
      contentType,
      baseRevision,
      author
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
      author
    );
  } catch (error) {
    await env.VAULT_BUCKET.delete(stagingKey);
    throw error;
  }
}

// ── Vault CRUD ─────────────────────────────────────────────────────────────

/** POST /api/vaults — create a new empty Web Vault */
vaultRoutes.post("/", requireSession, async (c) => {
  const session = c.get("session");
  const body = await c.req.json<{ name: string }>();

  const name = (body.name ?? "").trim();
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const vaultId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Persist vault record in D1 (owner index)
  await c.env.DB.prepare(
    `INSERT INTO vaults (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(vaultId, session.userId, name, now)
    .run();

  // Initialize the Durable Object for this vault
  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  await stub.initialize({ id: vaultId, ownerId: session.userId, name, createdAt: now });

  return c.json({ id: vaultId, name, createdAt: now }, 201);
});

/** GET /api/vaults — list authenticated user's vaults */
vaultRoutes.get("/", requireSession, async (c) => {
  const session = c.get("session");

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, created_at AS createdAt FROM vaults WHERE owner_id = ? ORDER BY created_at DESC`
  )
    .bind(session.userId)
    .all<{ id: string; name: string; createdAt: string }>();

  return c.json(results);
});

/** GET /api/vaults/:id — get a single vault (must be owner) */
vaultRoutes.get("/:id", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);
  return c.json(vault);
});

// ── Manifest ───────────────────────────────────────────────────────────────

/**
 * GET /api/vaults/:id/manifest
 * Returns the latest-content manifest for the vault.
 */
vaultRoutes.get("/:id/manifest", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const manifest = await stub.getManifest(id);

  return c.json({
    ...manifest,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).filter(
        ([, entry]) => !isVaultInternal(entry.path)
      )
    ),
  });
});

vaultRoutes.post("/:id/acks", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

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

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  try {
    return c.json(
      await stub.recordAcks(id, deviceAuthor("web", session.sessionId), { acks })
    );
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

vaultRoutes.get("/:id/conflicts", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);
  const stub = c.env.VAULT_COORDINATOR.get(
    c.env.VAULT_COORDINATOR.idFromName(id)
  );
  return c.json({
    conflicts: (await stub.listConflicts(id)).filter(
      (conflict) => !isVaultInternal(conflict.path)
    ),
  });
});

vaultRoutes.post("/:id/conflicts/resolve", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

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

  const stub = c.env.VAULT_COORDINATOR.get(
    c.env.VAULT_COORDINATOR.idFromName(id)
  );
  try {
    return c.json(
      await stub.resolveConflict(
        id,
        body as ResolveConflictRequest,
        deviceAuthor("web", session.sessionId)
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

// ── File content ───────────────────────────────────────────────────────────

/**
 * GET /api/vaults/:id/files/*
 * Stream a vault content file from R2.
 * Path is everything after `/files/`, e.g. `notes/hello.md`.
 *
 * Returns the file with appropriate Content-Type, or 404 if not in manifest.
 * Vault Internals are blocked even if somehow stored in R2.
 */
vaultRoutes.get("/:id/files/*", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  // Extract path after /files/
  const url = new URL(c.req.url);
  const prefix = `/api/vaults/${id}/files/`;
  const filePath = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!filePath) return c.json({ error: "Path required" }, 400);

  // Block vault internals
  if (isVaultInternal(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }

  // Verify vault ownership
  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const content = await stub.fetch(
    new Request(
      `https://do-internal/content?vaultId=${encodeURIComponent(id)}&path=${encodeURIComponent(filePath)}`
    )
  );
  if (content.status === 404) return c.json({ error: "Not found" }, 404);
  const headers = new Headers(content.headers);
  headers.set("Cache-Control", "private, max-age=30");
  return new Response(content.body, { status: content.status, headers });
});

// ── File mutations ─────────────────────────────────────────────────────────

/**
 * PUT /api/vaults/:id/files/*
 * Create or replace a Vault Content file.
 *
 * For text files (Markdown, plain text): body is JSON `{ content: string }`.
 * For binary/attachment uploads: body is raw bytes; caller must set Content-Type.
 *
 * OS junk paths are rejected with 400.
 */
vaultRoutes.put("/:id/files/*", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const url = new URL(c.req.url);
  const prefix = `/api/vaults/${id}/files/`;
  const filePath = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidVaultPath(filePath)) return c.json({ error: "Invalid path" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Cannot write to vault internals" }, 400);
  if (isOsJunk(filePath)) return c.json({ error: "OS junk files are not accepted" }, 400);

  const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
  const baseRevisionHeader = c.req.header("X-Base-Revision");
  const baseRevision = baseRevisionHeader === undefined ? undefined : Number(baseRevisionHeader);
  if (baseRevisionHeader !== undefined && !Number.isInteger(baseRevision)) {
    return c.json({ error: "Invalid base revision" }, 400);
  }

  let body: ArrayBuffer;
  let text: string | undefined;
  if (contentType.includes("application/json")) {
    const json = await c.req.json<{ content?: string }>();
    text = json.content ?? "";
    body = new TextEncoder().encode(text).buffer as ArrayBuffer;
  } else {
    body = await c.req.arrayBuffer();
  }

  // Determine the actual content type to store
  const storageContentType = contentTypeForUpload(filePath, contentType);

  try {
    const entry = await putWebBytes(
      c.env,
      id,
      filePath,
      body,
      storageContentType,
      baseRevision,
      deviceAuthor("web", session.sessionId)
    );
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; serverRevision?: number; headRevision?: number };
    if (err.status === 409) {
      const headRevision = err.headRevision ?? err.serverRevision;
      return c.json({ error: err.message ?? "Revision conflict", headRevision, serverRevision: headRevision }, 409);
    }
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 409 | 500);
  }
});

/**
 * PATCH /api/vaults/:id/files/*
 * Rename or move a file.
 * Body: `{ newPath: string }`
 */
vaultRoutes.patch("/:id/files/*", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const url = new URL(c.req.url);
  const prefix = `/api/vaults/${id}/files/`;
  const oldPath = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!oldPath) return c.json({ error: "Path required" }, 400);

  const body = await c.req.json<{ newPath?: string }>();
  const newPath = (body.newPath ?? "").trim();
  if (!newPath) return c.json({ error: "newPath is required" }, 400);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    const entry = await stub.renameFile(id, oldPath, newPath, deviceAuthor("web", session.sessionId));
    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 404 | 409 | 500);
  }
});

/**
 * DELETE /api/vaults/:id/files/*
 * Remove a file from R2 and the manifest.
 */
vaultRoutes.delete("/:id/files/*", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const url = new URL(c.req.url);
  const prefix = `/api/vaults/${id}/files/`;
  const filePath = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!filePath) return c.json({ error: "Path required" }, 400);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    await stub.deleteFile(id, filePath, deviceAuthor("web", session.sessionId));
    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
});

// ── Restore & Export (Slice 13) ────────────────────────────────────────────

/**
 * GET /api/vaults/:id/snapshots
 * Returns the sealed commit timeline from Artifacts.
 * Requires Artifacts access (Slice 04). Returns an empty array if the vault
 * has not been sealed yet (e.g. no writes since deployment).
 */
vaultRoutes.get("/:id/snapshots", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const snapshots = await stub.getLog(50);

  return c.json({ snapshots });
});

/** POST /api/vaults/:id/seal — manually seal pending changes to Artifacts. */
vaultRoutes.post("/:id/seal", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  try {
    return c.json(await stub.sealNow(`manual by ${session.sessionId}`), 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Seal failed" }, (err.status ?? 500) as 404 | 500);
  }
});

/**
 * POST /api/vaults/:id/files/:path/restore
 * Restore a single file to a specified content, creating a new revision.
 * This is an "append-only restore" — it writes new content as the latest
 * revision rather than moving history backward (per ADR 0003).
 *
 * Body: { content: string }  (text files only; binary restore via PUT)
 *
 * Callers supply the content they want to restore to (e.g. copied from a
 * Conflict Note or an older manual backup). The result is indexed and
 * broadcast like any other write.
 */
vaultRoutes.post("/:id/files/*/restore", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const url = new URL(c.req.url);
  // Strip /restore suffix to get the file path
  const prefix = `/api/vaults/${id}/files/`;
  let rawPath = decodeURIComponent(url.pathname.slice(prefix.length));
  if (rawPath.endsWith("/restore")) {
    rawPath = rawPath.slice(0, -"/restore".length);
  }

  const filePath = rawPath;
  if (!filePath) return c.json({ error: "Path required" }, 400);
  if (!isValidVaultPath(filePath)) return c.json({ error: "Invalid path" }, 400);
  if (isVaultInternal(filePath)) return c.json({ error: "Cannot restore vault internals" }, 400);

  const body = await c.req.json<{ content?: string }>();
  if (typeof body.content !== "string") {
    return c.json({ error: "content (string) is required" }, 400);
  }

  const contentType = detectMimeFromPath(filePath);
  const encoded = new TextEncoder().encode(body.content);

  try {
    const entry = await putWebBytes(
      c.env,
      id,
      filePath,
      encoded.buffer as ArrayBuffer,
      contentType,
      undefined,
      deviceAuthor("web", session.sessionId)
    );
    return c.json({ restored: true, entry }, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 409 | 500);
  }
});

/**
 * GET /api/vaults/:id/export
 * Download the latest Vault Content as a zip file.
 *
 * All files in the manifest (excluding Vault Internals) are fetched from R2
 * and packed into an uncompressed ZIP. The ZIP is streamed in-memory and
 * returned with Content-Disposition: attachment.
 *
 * Large vaults: all R2 fetches run concurrently for performance.
 * Vault Internals (.obsidian/ etc.) are excluded from the export.
 */
vaultRoutes.get("/:id/export", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const vault = await resolveVault(c.env.DB, id, session.userId);
  if (!vault) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const manifest = await stub.getManifest(id);

  const entries = Object.values(manifest.entries).filter(
    (e) => !isVaultInternal(e.path)
  );

  const zipEntries: ZipEntry[] = [];
  for (const entry of entries) {
    const content = await stub.fetch(
      new Request(
        `https://do-internal/content?vaultId=${encodeURIComponent(id)}&path=${encodeURIComponent(entry.path)}`
      )
    );
    if (content.ok) {
      zipEntries.push({
        path: entry.path,
        data: new Uint8Array(await content.arrayBuffer()),
      });
    } else {
      return c.json(
        { error: "Export failed because a vault blob is missing", path: entry.path },
        503
      );
    }
  }

  // Build the ZIP
  const zipBytes = buildZip(zipEntries);

  // Sanitize vault name for the filename
  const safeName = vault.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
  const filename = `${safeName}-export.zip`;

  return new Response(zipBytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
});

export { vaultRoutes };
