import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { createAuth } from "./auth";
import { vaultRoutes } from "./vault/routes";
import { searchRoutes } from "./search/routes";
import { deviceRoutes } from "./device/routes";
import { syncRoutes } from "./sync/routes";
import { notifyRoutes } from "./notify/routes";

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
app.route("/api/vaults", searchRoutes);
app.route("/api", deviceRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api", notifyRoutes);

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw) as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
});

export default app;
