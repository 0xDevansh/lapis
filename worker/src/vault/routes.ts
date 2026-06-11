import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";

const vaultRoutes = new Hono<{ Bindings: Env }>();

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

  const vault = await c.env.DB.prepare(
    `SELECT id, name, created_at AS createdAt FROM vaults WHERE id = ? AND owner_id = ?`
  )
    .bind(id, session.userId)
    .first<{ id: string; name: string; createdAt: string }>();

  if (!vault) return c.json({ error: "Not found" }, 404);
  return c.json(vault);
});

export { vaultRoutes };
