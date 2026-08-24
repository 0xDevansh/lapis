import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "./tokens";

export const mcpTokenRoutes = new Hono<{ Bindings: Env }>();

mcpTokenRoutes.get("/", requireSession, async (c) => {
  const session = c.get("session");
  return c.json(await listMcpTokens(c.env.DB, session.userId));
});

mcpTokenRoutes.post("/", requireSession, async (c) => {
  const session = c.get("session");
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  try {
    const created = await createMcpToken(c.env.DB, session.userId, body.name);
    return c.json(created, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create token";
    const status = message === "Token limit reached" ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

mcpTokenRoutes.delete("/:id", requireSession, async (c) => {
  const session = c.get("session");
  const revoked = await revokeMcpToken(c.env.DB, session.userId, c.req.param("id"));
  if (!revoked) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
