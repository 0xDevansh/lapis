import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import {
  denyAccess,
  getUserByEmail,
  getUserEmail,
  normalizeEmail,
  resolveVaultAccess,
  type VaultRole,
} from "./access";

const inviteInboxRoutes = new Hono<{ Bindings: Env }>();
const vaultMemberRoutes = new Hono<{ Bindings: Env }>();

interface InviteRow {
  id: string;
  vaultId: string;
  vaultName: string;
  email: string;
  role: "editor" | "viewer";
  invitedBy: string;
  invitedByEmail: string | null;
  invitedByName: string | null;
  status: string;
  createdAt: string;
}

interface MemberRow {
  userId: string;
  role: VaultRole;
  email: string;
  name: string;
  createdAt: string;
}

function isInviteRole(value: string): value is "editor" | "viewer" {
  return value === "editor" || value === "viewer";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loadInvite(
  db: D1Database,
  inviteId: string
): Promise<InviteRow | null> {
  const row = await db
    .prepare(
      `SELECT i.id, i.vault_id AS vaultId, v.name AS vaultName, i.email, i.role,
              i.invited_by AS invitedBy, u.email AS invitedByEmail, u.name AS invitedByName,
              i.status, i.created_at AS createdAt
       FROM vault_invites i
       JOIN vaults v ON v.id = i.vault_id
       LEFT JOIN "user" u ON u.id = i.invited_by
       WHERE i.id = ?`
    )
    .bind(inviteId)
    .first<InviteRow>();
  return row;
}

inviteInboxRoutes.get("/", requireSession, async (c) => {
  const session = c.get("session");
  const email = await getUserEmail(c.env.DB, session.userId);
  if (!email) return c.json({ error: "Unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.vault_id AS vaultId, v.name AS vaultName, i.email, i.role,
            i.invited_by AS invitedBy, u.email AS invitedByEmail, u.name AS invitedByName,
            i.status, i.created_at AS createdAt
     FROM vault_invites i
     JOIN vaults v ON v.id = i.vault_id
     LEFT JOIN "user" u ON u.id = i.invited_by
     WHERE i.email = ? AND i.status = 'pending' AND v.archived_at IS NULL
     ORDER BY i.created_at DESC`
  )
    .bind(email)
    .all<InviteRow>();

  return c.json(results ?? []);
});

inviteInboxRoutes.post("/:id/accept", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const email = await getUserEmail(c.env.DB, session.userId);
  if (!email) return c.json({ error: "Unauthorized" }, 401);

  const invite = await loadInvite(c.env.DB, id);
  if (!invite || invite.status !== "pending") {
    return c.json({ error: "Not found" }, 404);
  }
  if (normalizeEmail(invite.email) !== email) {
    return c.json({ error: "Not found" }, 404);
  }

  const existing = await c.env.DB.prepare(
    `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
  )
    .bind(invite.vaultId, session.userId)
    .first<{ role: string }>();

  const now = new Date().toISOString();
  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO vault_members (vault_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(invite.vaultId, session.userId, invite.role, now)
      .run();
  }

  await c.env.DB.prepare(
    `UPDATE vault_invites SET status = 'accepted' WHERE id = ? AND status = 'pending'`
  )
    .bind(id)
    .run();

  const access = await resolveVaultAccess(c.env.DB, invite.vaultId, session.userId);
  return c.json({
    ok: true,
    vaultId: invite.vaultId,
    vaultName: invite.vaultName,
    role: access?.role ?? invite.role,
  });
});

inviteInboxRoutes.post("/:id/reject", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const email = await getUserEmail(c.env.DB, session.userId);
  if (!email) return c.json({ error: "Unauthorized" }, 401);

  const invite = await loadInvite(c.env.DB, id);
  if (!invite || invite.status !== "pending") {
    return c.json({ error: "Not found" }, 404);
  }
  if (normalizeEmail(invite.email) !== email) {
    return c.json({ error: "Not found" }, 404);
  }

  await c.env.DB.prepare(
    `UPDATE vault_invites SET status = 'rejected' WHERE id = ? AND status = 'pending'`
  )
    .bind(id)
    .run();

  return c.json({ ok: true });
});

vaultMemberRoutes.get("/:id/members", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "read");
  if (denied) return denied;

  const { results } = await c.env.DB.prepare(
    `SELECT m.user_id AS userId, m.role AS role, u.email, u.name, m.created_at AS createdAt
     FROM vault_members m
     JOIN "user" u ON u.id = m.user_id
     WHERE m.vault_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.created_at`
  )
    .bind(id)
    .all<MemberRow>();

  return c.json(results ?? []);
});

vaultMemberRoutes.patch("/:id/members/:userId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, userId } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "admin");
  if (denied) return denied;

  const body = await c.req.json<{ role?: string }>();
  const role = (body.role ?? "").trim();
  if (!isInviteRole(role)) {
    return c.json({ error: "role must be editor or viewer" }, 400);
  }

  const member = await c.env.DB.prepare(
    `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<{ role: string }>();
  if (!member) return c.json({ error: "Not found" }, 404);
  if (member.role === "owner") {
    return c.json({ error: "Cannot change the vault owner role" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?`
  )
    .bind(role, id, userId)
    .run();

  return c.json({ ok: true, userId, role });
});

vaultMemberRoutes.delete("/:id/members/:userId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, userId } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "admin");
  if (denied) return denied;

  const member = await c.env.DB.prepare(
    `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<{ role: string }>();
  if (!member) return c.json({ error: "Not found" }, 404);
  if (member.role === "owner") {
    return c.json({ error: "Cannot remove the vault owner" }, 400);
  }

  await c.env.DB.prepare(
    `DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  return c.json({ ok: true });
});

vaultMemberRoutes.get("/:id/invites", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "invite");
  if (denied) return denied;

  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.vault_id AS vaultId, v.name AS vaultName, i.email, i.role,
            i.invited_by AS invitedBy, u.email AS invitedByEmail, u.name AS invitedByName,
            i.status, i.created_at AS createdAt
     FROM vault_invites i
     JOIN vaults v ON v.id = i.vault_id
     LEFT JOIN "user" u ON u.id = i.invited_by
     WHERE i.vault_id = ? AND i.status = 'pending'
     ORDER BY i.created_at DESC`
  )
    .bind(id)
    .all<InviteRow>();

  return c.json(results ?? []);
});

vaultMemberRoutes.post("/:id/invites", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "invite");
  if (denied) return denied;

  const body = await c.req.json<{ email?: string; role?: string }>();
  const email = normalizeEmail(body.email ?? "");
  const role = (body.role ?? "").trim();
  if (!isEmail(email)) return c.json({ error: "A valid email is required" }, 400);
  if (!isInviteRole(role)) {
    return c.json({ error: "role must be editor or viewer" }, 400);
  }

  const inviterEmail = await getUserEmail(c.env.DB, session.userId);
  if (inviterEmail && inviterEmail === email) {
    return c.json({ error: "You cannot invite yourself" }, 400);
  }

  const existingUser = await getUserByEmail(c.env.DB, email);
  if (existingUser) {
    const member = await c.env.DB.prepare(
      `SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?`
    )
      .bind(id, existingUser.id)
      .first<{ role: string }>();
    if (member) {
      return c.json({ error: "That person is already a member" }, 409);
    }
  }

  const pending = await c.env.DB.prepare(
    `SELECT id FROM vault_invites WHERE vault_id = ? AND email = ? AND status = 'pending'`
  )
    .bind(id, email)
    .first<{ id: string }>();
  if (pending) {
    return c.json({ error: "An invite is already pending for that email" }, 409);
  }

  const inviteId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO vault_invites (id, vault_id, email, role, invited_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(inviteId, id, email, role, session.userId, now)
    .run();

  return c.json(
    {
      id: inviteId,
      vaultId: id,
      vaultName: access!.vault.name,
      email,
      role,
      invitedBy: session.userId,
      status: "pending",
      createdAt: now,
    },
    201
  );
});

vaultMemberRoutes.delete("/:id/invites/:inviteId", requireSession, async (c) => {
  const session = c.get("session");
  const { id, inviteId } = c.req.param();
  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "invite");
  if (denied) return denied;

  const invite = await c.env.DB.prepare(
    `SELECT id, invited_by AS invitedBy, status FROM vault_invites
     WHERE id = ? AND vault_id = ?`
  )
    .bind(inviteId, id)
    .first<{ id: string; invitedBy: string; status: string }>();
  if (!invite || invite.status !== "pending") {
    return c.json({ error: "Not found" }, 404);
  }
  if (access!.role !== "owner" && invite.invitedBy !== session.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE vault_invites SET status = 'cancelled' WHERE id = ? AND status = 'pending'`
  )
    .bind(inviteId)
    .run();

  return c.json({ ok: true });
});

export { inviteInboxRoutes, vaultMemberRoutes };
