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
import { gitRoutes } from "./git/routes";
import { memberRoutes, inviteAcceptRoutes } from "./vault/members";
import { mcpRoutes } from "./mcp/routes";
import { handleVaultMcp } from "./mcp/server";

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

// ── MCP (stateless streamable HTTP) — before other /api catch-alls ───────────
app.all("/api/mcp/:vaultId", (c) => handleVaultMcp(c.req.raw, c.env, c.executionCtx));
app.all("/api/mcp/:vaultId/*", (c) => handleVaultMcp(c.req.raw, c.env, c.executionCtx));

// ── API routes ───────────────────────────────────────────────────────────────
app.route("/api/vaults", vaultRoutes);
app.route("/api/vaults", memberRoutes);
app.route("/api/vaults", mcpRoutes);
app.route("/api/vaults", searchRoutes);
app.route("/api", deviceRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api", notifyRoutes);
app.route("/api", gitRoutes);
app.route("/api", inviteAcceptRoutes);

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }

  const lastSegment = url.pathname.split("/").pop() ?? "";
  const looksLikeAsset = lastSegment.includes(".");
  if (!looksLikeAsset) {
    const indexUrl = new URL("/index.html", c.req.url);
    return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw) as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
  }

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const indexUrl = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw) as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
});

export default app;
