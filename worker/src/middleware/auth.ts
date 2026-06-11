import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env } from "../types";
import { createAuth } from "../auth";

/**
 * Require a valid better-auth session.
 * Sets `c.set("session", session)` on success; returns 401 otherwise.
 */
export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (
  c: Context<{ Bindings: Env }>,
  next: Next
) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session?.session || !session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("session", { userId: session.user.id, sessionId: session.session.id });
  await next();
};
