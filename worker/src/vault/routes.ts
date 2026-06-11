import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { isVaultInternal } from "./path";
import { contentKey } from "./manifest";

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

export { vaultRoutes };
