import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types";
import { createAuth } from "./auth";
import { vaultRoutes } from "./vault/routes";
import { searchRoutes } from "./search/routes";

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

// ── Dev utility: apply D1 schema ─────────────────────────────────────────────
app.post("/api/admin/migrate", async (c) => {
  if (c.env.BETTER_AUTH_URL?.includes("localhost")) {
    // Core tables
    await c.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vaults_owner ON vaults (owner_id);
    `);
    // Search + backlinks + tags (Slice 06)
    await c.env.DB.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
        vault_id UNINDEXED,
        path     UNINDEXED,
        filename,
        content,
        tokenize = 'porter unicode61'
      );
    `);
    await c.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS backlinks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id    TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        UNIQUE (vault_id, source_path, target_path)
      );
      CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (vault_id, target_path);
      CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks (vault_id, source_path);
    `);
    await c.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS note_tags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id    TEXT NOT NULL,
        note_path   TEXT NOT NULL,
        tag         TEXT NOT NULL,
        UNIQUE (vault_id, note_path, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_note_tags_tag  ON note_tags (vault_id, tag);
      CREATE INDEX IF NOT EXISTS idx_note_tags_path ON note_tags (vault_id, note_path);
    `);
    return c.json({ ok: true });
  }
  return c.json({ error: "Forbidden" }, 403);
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof c.env.ASSETS.fetch>[0]));

export default app;
