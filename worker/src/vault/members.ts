import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { AccessError, requireVaultAccess } from "../auth/access";
import type { VaultRole } from "../auth/permissions";

const memberRoutes = new Hono<{ Bindings: Env }>();

function handleAccessError(e: unknown): Response | null {
  if (e instanceof AccessError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return null;
}

/** GET /api/vaults/:id/members */
memberRoutes.get("/:id/members", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { member: "read" });
  } catch (e) {
    const res = handleAccessError(e);
    if (res) return res;
    throw e;
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.user_id AS userId, m.role, m.created_at AS createdAt,
            u.name, u.email
     FROM vault_members m
     INNER JOIN "user" u ON u.id = m.user_id
     WHERE m.vault_id = ?
     ORDER BY m.created_at ASC`
  )
    .bind(id)
    .all<{ userId: string; role: VaultRole; createdAt: string; name: string; email: string }>();

  return c.json(results ?? []);
});

/** POST /api/vaults/:id/invites — create invite link */
memberRoutes.post("/:id/invites", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { invitation: "create" });
  } catch (e) {
    const res = handleAccessError(e);
    if (res) return res;
    throw e;
  }

  const body = await c.req.json<{ email: string; role?: "editor" | "viewer" }>();
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role === "viewer" ? "viewer" : "editor";
  if (!email || !email.includes("@")) {
    return c.json({ error: "Valid email is required" }, 400);
  }

  const inviteId = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await c.env.DB.prepare(
    `INSERT INTO vault_invites (id, vault_id, email, role, token, invited_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(inviteId, id, email, role, token, session.userId, expires.toISOString(), now.toISOString())
    .run();

  return c.json(
    {
      id: inviteId,
      email,
      role,
      token,
      expiresAt: expires.toISOString(),
      acceptPath: `/invites/${token}`,
    },
    201
  );
});

/** GET /api/vaults/:id/invites */
memberRoutes.get("/:id/invites", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { invitation: "create" });
  } catch (e) {
    const res = handleAccessError(e);
    if (res) return res;
    throw e;
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, email, role, token, expires_at AS expiresAt, created_at AS createdAt
     FROM vault_invites WHERE vault_id = ? ORDER BY created_at DESC`
  )
    .bind(id)
    .all();

  return c.json(results ?? []);
});

/** POST /api/invites/:token/accept — mounted separately in index */
export const inviteAcceptRoutes = new Hono<{ Bindings: Env }>();

inviteAcceptRoutes.post("/invites/:token/accept", requireSession, async (c) => {
  const session = c.get("session");
  const { token } = c.req.param();

  const invite = await c.env.DB.prepare(
    `SELECT id, vault_id AS vaultId, email, role, expires_at AS expiresAt
     FROM vault_invites WHERE token = ?`
  )
    .bind(token)
    .first<{ id: string; vaultId: string; email: string; role: "editor" | "viewer"; expiresAt: string }>();

  if (!invite) return c.json({ error: "Invite not found" }, 404);
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return c.json({ error: "Invite expired" }, 410);
  }

  const user = await c.env.DB.prepare(`SELECT email FROM "user" WHERE id = ?`)
    .bind(session.userId)
    .first<{ email: string }>();

  if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return c.json({ error: "Invite email does not match your account" }, 403);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO vault_members (vault_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_id, user_id) DO UPDATE SET role = excluded.role`
  )
    .bind(invite.vaultId, session.userId, invite.role, now)
    .run();

  await c.env.DB.prepare(`DELETE FROM vault_invites WHERE id = ?`).bind(invite.id).run();

  return c.json({ vaultId: invite.vaultId, role: invite.role });
});

/** PATCH /api/vaults/:id/members/:userId — change role */
memberRoutes.patch("/:id/members/:userId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, userId } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { member: "update" });
  } catch (e) {
    const res = handleAccessError(e);
    if (res) return res;
    throw e;
  }

  const body = await c.req.json<{ role: VaultRole }>();
  if (body.role !== "owner" && body.role !== "editor" && body.role !== "viewer") {
    return c.json({ error: "Invalid role" }, 400);
  }
  if (userId === session.userId && body.role !== "owner") {
    return c.json({ error: "Cannot demote yourself" }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?`
  )
    .bind(body.role, id, userId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Member not found" }, 404);

  if (body.role === "owner") {
    await c.env.DB.prepare(`UPDATE vaults SET owner_id = ? WHERE id = ?`).bind(userId, id).run();
  }

  return c.json({ userId, role: body.role });
});

/** DELETE /api/vaults/:id/members/:userId */
memberRoutes.delete("/:id/members/:userId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, userId } = c.req.param();
  try {
    await requireVaultAccess(c.env.DB, id, session.userId, { member: "delete" });
  } catch (e) {
    const res = handleAccessError(e);
    if (res) return res;
    throw e;
  }

  if (userId === session.userId) {
    return c.json({ error: "Cannot remove yourself; transfer ownership first" }, 400);
  }

  const target = await c.env.DB.prepare(
    `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<{ role: VaultRole }>();

  if (!target) return c.json({ error: "Member not found" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "Cannot remove the owner" }, 400);
  }

  await c.env.DB.prepare(`DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();

  return c.json({ ok: true });
});

export { memberRoutes };
