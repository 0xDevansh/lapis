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
import { denyAccess, resolveVaultAccess } from "../vault/access";

const searchRoutes = new Hono<{ Bindings: Env }>();

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

  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "read");
  if (denied) return denied;

  // Sanitize query: strip characters unsafe in FTS5 queries, add * for prefix search
  const safeQuery = sanitizeFtsQuery(q);
  if (!safeQuery) return c.json<SearchResult[]>([]);

  const filenameExact = q.toLowerCase();
  const filenamePrefix = `${filenameExact}%`;
  const filenameContains = `%${filenameExact}%`;

  const { results } = await c.env.DB.prepare(
    `SELECT
       path,
       snippet(vault_fts, 3, '**', '**', '…', 32) AS snippet
     FROM vault_fts
     WHERE vault_id = ? AND vault_fts MATCH ?
      ORDER BY
        CASE
          WHEN lower(filename) = ? THEN 0
          WHEN lower(filename) LIKE ? THEN 1
          WHEN lower(filename) LIKE ? THEN 2
          ELSE 3
        END,
        bm25(vault_fts, 0, 0, 1, 10)
      LIMIT 20`
  )
    .bind(id, safeQuery, filenameExact, filenamePrefix, filenameContains)
    .all<{ path: string; snippet: string }>();

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const manifest = await stub.getManifest(id);
  const canonicalPaths = new Map(
    Object.values(manifest.entries).map((entry) => [entry.path.toLowerCase(), entry.path])
  );

  return c.json<SearchResult[]>(
    (results ?? []).map((result) => ({
      ...result,
      path: canonicalPaths.get(result.path.toLowerCase()) ?? result.path,
    }))
  );
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

  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "read");
  if (denied) return denied;

  const { results } = await c.env.DB.prepare(
    `SELECT source_path AS sourcePath
     FROM backlinks
     WHERE vault_id = ? AND target_path = ?
     ORDER BY source_path`
  )
    .bind(id, path.toLowerCase())
    .all<{ sourcePath: string }>();

  const doId = c.env.VAULT_COORDINATOR.idFromName(id);
  const stub = c.env.VAULT_COORDINATOR.get(doId);
  const manifest = await stub.getManifest(id);
  const canonicalPaths = new Map(
    Object.values(manifest.entries).map((entry) => [entry.path.toLowerCase(), entry.path])
  );

  return c.json<BacklinkResult[]>(
    (results ?? []).map((result) => ({
      sourcePath: canonicalPaths.get(result.sourcePath.toLowerCase()) ?? result.sourcePath,
    }))
  );
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

  const access = await resolveVaultAccess(c.env.DB, id, session.userId);
  const denied = denyAccess(c, access, "read");
  if (denied) return denied;

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
