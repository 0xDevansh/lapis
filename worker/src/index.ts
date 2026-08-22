import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { createAuth, getTrustedOrigins } from "./auth";
import { vaultRoutes } from "./vault/routes";
import { searchRoutes } from "./search/routes";
import { deviceRoutes } from "./device/routes";
import { syncRoutes } from "./sync/routes";
import { notifyRoutes } from "./notify/routes";
import { gitRoutes } from "./git/routes";

export { VaultCoordinator } from "./vault/coordinator";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin, c) =>
      getTrustedOrigins(c.env.BETTER_AUTH_URL).includes(origin)
        ? origin
        : undefined,
    credentials: true,
  })
);

// ── better-auth handler ──────────────────────────────────────────────────────
app.get("/api/auth/providers", (c) =>
  c.json(
    {
      google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
);

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
app.route("/api", gitRoutes);

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }

  const lastSegment = url.pathname.split("/").pop() ?? "";
  const looksLikeAsset = lastSegment.includes(".");
  if (!looksLikeAsset) {
    // Fetch the canonical root document. Cloudflare Static Assets redirects
    // /index.html to /, which would otherwise erase SPA routes such as /auth
    // (including OAuth error query parameters).
    const indexUrl = new URL("/", c.req.url);
    return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw) as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
  }

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const indexUrl = new URL("/", c.req.url);
  return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw) as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]);
});

export default app;
