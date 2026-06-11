import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { isValidVaultPath, isVaultInternal, isOsJunk } from "./path";
import { contentKey } from "./manifest";
import { indexFile, removeFromIndex, renameInIndex } from "../search/indexer";

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

  // Fetch from R2
  const r2Key = contentKey(id, filePath);
  const obj = await c.env.VAULT_BUCKET.get(r2Key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  const contentType =
    obj.httpMetadata?.contentType ?? "application/octet-stream";

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=30",
      "Content-Length": String(obj.size),
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

  let body: ArrayBuffer;
  if (contentType.includes("application/json")) {
    const json = await c.req.json<{ content?: string }>();
    const text = json.content ?? "";
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
    const entry = await stub.putFile(id, filePath, body, storageContentType);

    // Update search index (fire-and-forget; don't fail the request if indexing fails)
    const textContent = storageContentType.startsWith("text/") || storageContentType === "application/json"
      ? new TextDecoder().decode(body)
      : undefined;
    const manifest = await stub.getManifest(id);
    const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
    indexFile(c.env.DB, { vaultId: id, path: filePath, content: textContent, vaultPaths }).catch(() => {});

    return c.json(entry, 200);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
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
    const entry = await stub.renameFile(id, oldPath, newPath);

    // Update search index for the renamed file (fetch content if it's text)
    let newContent: string | undefined;
    if (entry.contentType.startsWith("text/") || entry.contentType === "application/json") {
      try {
        const r2Key = contentKey(id, newPath);
        const obj = await c.env.VAULT_BUCKET.get(r2Key);
        if (obj) newContent = await obj.text();
      } catch { /* ignore */ }
    }
    const manifest = await stub.getManifest(id);
    const vaultPaths = Object.values(manifest.entries).map((e) => e.path);
    renameInIndex(c.env.DB, id, oldPath, newPath, newContent, vaultPaths).catch(() => {});

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
    await stub.deleteFile(id, filePath);

    // Remove from search index
    removeFromIndex(c.env.DB, id, filePath).catch(() => {});

    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? "Failed" }, (err.status ?? 500) as 400 | 500);
  }
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
