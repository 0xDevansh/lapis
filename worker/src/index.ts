import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { createAuth, getMcpResourceURL, getTrustedOrigins } from "./auth";
import { requireMcpAuth } from "@better-auth/mcp";
import { vaultRoutes } from "./vault/routes";
import { inviteInboxRoutes, vaultMemberRoutes } from "./vault/invites";
import { searchRoutes } from "./search/routes";
import { deviceRoutes } from "./device/routes";
import { syncRoutes } from "./sync/routes";
import { notifyRoutes } from "./notify/routes";
import { gitRoutes } from "./git/routes";
import { createLapisMcpHandler } from "./mcp/server";
import { mcpTokenRoutes } from "./mcp/routes";
import { extractBearerToken, isMcpPersonalToken, resolveMcpBearerToken, touchMcpToken } from "./mcp/tokens";

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

// RFC 8414 / RFC 9728 discovery lives at the issuer origin, not under /api/auth.
app.use("/.well-known/*", cors({ origin: "*" }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.all("/.well-known/*", (c): any => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// ── API routes ───────────────────────────────────────────────────────────────
app.route("/api/mcp/tokens", mcpTokenRoutes);

app.all("/api/mcp", async (c) => {
  const bearer = extractBearerToken(c.req.header("Authorization"));
  if (bearer && isMcpPersonalToken(bearer)) {
    const record = await resolveMcpBearerToken(c.env.DB, bearer);
    if (!record) return c.json({ error: "Unauthorized" }, 401);
    c.executionCtx.waitUntil(touchMcpToken(c.env.DB, record.id));
    return createLapisMcpHandler(c.env, {
      sub: record.userId,
      client_id: `token:${record.id}`,
    }).fetch(c.req.raw);
  }

  const auth = createAuth(c.env);
  const resource = getMcpResourceURL(c.env.BETTER_AUTH_URL);
  const protectedHandler = requireMcpAuth(
    auth,
    async (request, claims) => createLapisMcpHandler(c.env, claims).fetch(request),
    {
      resource,
      challengeScopes: ["openid", "profile", "offline_access", "mcp:read"],
    }
  );
  return protectedHandler(c.req.raw);
});

app.route("/api/vaults", vaultRoutes);
app.route("/api/vaults", vaultMemberRoutes);
app.route("/api/invites", inviteInboxRoutes);
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
