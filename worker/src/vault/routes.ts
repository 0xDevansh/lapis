import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { isValidVaultPath, isVaultInternal, isOsJunk } from "./path";
import { deviceAuthor } from "./identity";
import { buildZip, type ZipEntry } from "./zip";

const vaultRoutes = new Hono<{ Bindings: Env }>();

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

  return c.json(manifest);
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
  const content = await stub.getContent(id, filePath);
  if (!content) return c.json({ error: "Not found" }, 404);

  return new Response(content.bytes, {
    headers: {
      "Content-Type": content.contentType,
      "Cache-Control": "private, max-age=30",
      "Content-Length": String(content.bytes.byteLength),
      "X-Revision": String(content.revision),
    },
  });
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

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  // Determine the actual content type to store
  const storageContentType = contentType.includes("application/json")
    ? detectMimeFromPath(filePath)
    : contentType.split(";")[0].trim();

  try {
    const entry = await stub.syncPutFile(id, filePath, body, storageContentType, baseRevision, deviceAuthor("web", session.sessionId));
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

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);

  try {
    const entry = await stub.syncPutFile(id, filePath, encoded.buffer as ArrayBuffer, contentType, undefined, deviceAuthor("web", session.sessionId));
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
    const content = await stub.getContent(id, entry.path);
    if (content) {
      zipEntries.push({ path: entry.path, data: new Uint8Array(content.bytes) });
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

// ── Helpers ────────────────────────────────────────────────────────────────

function detectMimeFromPath(path: string): string {
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

export { vaultRoutes };
