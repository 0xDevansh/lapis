/**
 * Git remote owner-authenticated routes — Slices 25–26.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { encryptPat, patLast4 } from "./crypto";
import { deleteGitRemote, getGitRemote, publicGitRemoteMeta, updateGitRemoteState, upsertGitRemote } from "./store";

const gitRoutes = new Hono<{ Bindings: Env }>();

async function verifyVaultOwner(db: D1Database, vaultId: string, userId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT vault_id AS id FROM vault_members WHERE vault_id = ? AND user_id = ?`).bind(vaultId, userId).first();
  return !!row;
}

gitRoutes.put("/vaults/:id/git-remote", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  if (!(await verifyVaultOwner(c.env.DB, id, session.userId))) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ repoUrl?: string; branch?: string; subdir?: string; pat?: string }>();
  const repoUrl = (body.repoUrl ?? "").trim();
  const branch = (body.branch ?? "main").trim();
  const subdir = body.subdir?.trim() || null;
  const pat = (body.pat ?? "").trim();
  if (!repoUrl || !pat) return c.json({ error: "repoUrl and pat are required" }, 400);
  if (!c.env.GITHUB_PAT_ENCRYPTION_KEY) {
    return c.json({ error: "GitHub PAT encryption is not configured (set GITHUB_PAT_ENCRYPTION_KEY)" }, 500);
  }

  const patCiphertext = await encryptPat(c.env.GITHUB_PAT_ENCRYPTION_KEY, pat);
  await upsertGitRemote(c.env.DB, {
    vaultId: id,
    repoUrl,
    branch,
    subdir,
    patCiphertext,
    patLast4: patLast4(pat),
  });

  return c.json(publicGitRemoteMeta({
    vaultId: id,
    provider: "github",
    repoUrl,
    branch,
    subdir,
    patCiphertext,
    patLast4: patLast4(pat),
    webhookSecret: null,
    lastSyncedCommit: null,
    lastSyncedAt: null,
    syncState: "idle",
  }));
});

gitRoutes.get("/vaults/:id/git-remote", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  if (!(await verifyVaultOwner(c.env.DB, id, session.userId))) return c.json({ error: "Not found" }, 404);

  const row = await getGitRemote(c.env.DB, id);
  if (!row) return c.json({ connected: false });
  return c.json({ connected: true, ...publicGitRemoteMeta(row) });
});

gitRoutes.delete("/vaults/:id/git-remote", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  if (!(await verifyVaultOwner(c.env.DB, id, session.userId))) return c.json({ error: "Not found" }, 404);
  await deleteGitRemote(c.env.DB, id);
  return c.json({ ok: true });
});

gitRoutes.post("/vaults/:id/git-remote/push", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  if (!(await verifyVaultOwner(c.env.DB, id, session.userId))) return c.json({ error: "Not found" }, 404);

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const result = await c.env.VAULT_COORDINATOR.get(doId).sealNow("manual push");
  return c.json({ ok: true, ...result });
});

gitRoutes.post("/webhooks/github/:vaultId", async (c) => {
  const { vaultId } = c.req.param();
  const row = await getGitRemote(c.env.DB, vaultId);
  if (!row) return c.json({ error: "Not found" }, 404);

  const signature = c.req.header("X-Hub-Signature-256") ?? "";
  if (row.webhookSecret && signature) {
    const body = await c.req.text();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(row.webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expected = `sha256=${Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (expected !== signature) return c.json({ error: "Invalid signature" }, 401);
  }

  const doId = c.env.VAULT_COORDINATOR.idFromName(vaultId);
  await c.env.VAULT_COORDINATOR.get(doId).sealNow("github webhook");
  return c.json({ ok: true });
});

export { gitRoutes };
