import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { createAuth } from "./auth";
import { vaultRoutes } from "./vault/routes";

export { VaultCoordinator } from "./vault/coordinator";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin, // reflect origin; auth is cookie-based
    credentials: true,
  })
);

// ── better-auth handler ──────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.all("/api/auth/*", (c): any => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// ── API routes ───────────────────────────────────────────────────────────────
app.route("/api/vaults", vaultRoutes);

// ── Dev utility: apply D1 schema ─────────────────────────────────────────────
app.post("/api/admin/migrate", async (c) => {
  if (c.env.BETTER_AUTH_URL?.includes("localhost")) {
    await c.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vaults_owner ON vaults (owner_id);
    `);
    return c.json({ ok: true });
  }
  return c.json({ error: "Forbidden" }, 403);
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]));

export default app;
