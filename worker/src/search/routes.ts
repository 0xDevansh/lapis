/**
 * Search, backlinks, and tags API routes — Slice 06.
 *
 * GET /api/vaults/:id/search?q=<query>
 * GET /api/vaults/:id/backlinks?path=<path>
 * GET /api/vaults/:id/tags
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { requireSession } from "../middleware/auth";

const searchRoutes = new Hono<{ Bindings: Env }>();

// ── Helper: verify vault ownership ───────────────────────────────────────────

async function resolveVault(
  db: D1Database,
  vaultId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM vaults WHERE id = ? AND owner_id = ?`)
    .bind(vaultId, userId)
    .first<{ id: string }>();
  return row !== null;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  snippet: string;
}

/**
 * GET /api/vaults/:id/search?q=<query>
 *
 * Returns up to 20 results ordered by BM25 relevance.
 * Each result includes a 160-char snippet with matched terms highlighted
 * by surrounding ** markers (the client can render these).
 */
searchRoutes.get("/:id/search", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const q = (c.req.query("q") ?? "").trim();

  if (!q) return c.json<SearchResult[]>([]);

  const owned = await resolveVault(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  // Sanitize query: strip characters unsafe in FTS5 queries, add * for prefix search
  const safeQuery = sanitizeFtsQuery(q);
  if (!safeQuery) return c.json<SearchResult[]>([]);

  const { results } = await c.env.DB.prepare(
    `SELECT
       path,
       snippet(vault_fts, 3, '**', '**', '…', 32) AS snippet
     FROM vault_fts
     WHERE vault_id = ? AND vault_fts MATCH ?
     ORDER BY bm25(vault_fts, 0, 0, 1, 10)
     LIMIT 20`
  )
    .bind(id, safeQuery)
    .all<{ path: string; snippet: string }>();

  return c.json<SearchResult[]>(results ?? []);
});

// ── Backlinks ─────────────────────────────────────────────────────────────────

export interface BacklinkResult {
  sourcePath: string;
}

/**
 * GET /api/vaults/:id/backlinks?path=<path>
 *
 * Returns all notes that link to the given path via [[wikilinks]].
 */
searchRoutes.get("/:id/backlinks", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();
  const path = (c.req.query("path") ?? "").trim();

  if (!path) return c.json<BacklinkResult[]>([]);

  const owned = await resolveVault(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT source_path AS sourcePath
     FROM backlinks
     WHERE vault_id = ? AND target_path = ?
     ORDER BY source_path`
  )
    .bind(id, path.toLowerCase())
    .all<{ sourcePath: string }>();

  return c.json<BacklinkResult[]>(results ?? []);
});

// ── Tags ──────────────────────────────────────────────────────────────────────

export interface TagResult {
  tag: string;
  count: number;
}

/**
 * GET /api/vaults/:id/tags
 *
 * Returns all tags across the vault with occurrence counts.
 */
searchRoutes.get("/:id/tags", requireSession, async (c) => {
  const session = c.get("session");
  const { id } = c.req.param();

  const owned = await resolveVault(c.env.DB, id, session.userId);
  if (!owned) return c.json({ error: "Not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT tag, COUNT(*) AS count
     FROM note_tags
     WHERE vault_id = ?
     GROUP BY tag
     ORDER BY count DESC, tag ASC`
  )
    .bind(id)
    .all<{ tag: string; count: number }>();

  return c.json<TagResult[]>(results ?? []);
});

// ── FTS query sanitization ────────────────────────────────────────────────────

/**
 * Convert a user query into a safe FTS5 query string.
 * - Strips FTS5 operators/punctuation that could cause parse errors.
 * - Adds a trailing * for prefix search on the last token.
 */
function sanitizeFtsQuery(q: string): string {
  // Remove characters that are special in FTS5 and could cause errors
  const clean = q.replace(/["""''`^*+()\[\]{}|\\<>]/g, " ").trim();
  if (!clean) return "";

  // Split into tokens and quote each one; add * to last for prefix search
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  return tokens
    .map((t, i) => {
      const escaped = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? escaped + "*" : escaped;
    })
    .join(" ");
}

export { searchRoutes };
