/**
 * Vault content indexer — Slice 06.
 *
 * Runs inside the Worker (not the DO) after each file mutation so that
 * D1 FTS, backlinks, and note_tags are always up-to-date with Vault Content.
 *
 * Vault Internals are never indexed.
 */

import { isVaultInternal } from "../vault/path";

// ── Simple wikilink extraction (server-side, no gray-matter) ──────────────────

const WIKILINK_RE = /!?\[\[([^\]]+?)\]\]/g;

/**
 * Extract all [[target]] references from Markdown source.
 * Returns only the target part (before | or #).
 */
function extractWikilinkTargets(source: string): string[] {
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(source)) !== null) {
    let inner = m[1];
    // Strip alias: [[target|alias]] → target
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx !== -1) inner = inner.slice(0, pipeIdx);
    // Strip heading: [[target#heading]] → target
    const hashIdx = inner.indexOf("#");
    if (hashIdx !== -1) inner = inner.slice(0, hashIdx);
    const target = inner.trim();
    if (target) targets.push(target);
  }
  return targets;
}

// ── Simple frontmatter + inline tag extraction ────────────────────────────────

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const INLINE_TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g;

function extractTags(source: string): string[] {
  const tags = new Set<string>();

  // Strip frontmatter YAML and extract `tags:` field
  const fmMatch = FM_RE.exec(source);
  let body = source;
  if (fmMatch) {
    const yaml = fmMatch[1];
    body = source.slice(fmMatch[0].length);
    // Find `tags: [a, b]` or `tags:\n  - a`
    const tagsLine = yaml.match(/^tags:\s*(.+)$/m);
    if (tagsLine) {
      // Inline list: tags: [a, b, c]
      const bracketed = tagsLine[1].match(/^\[(.+)\]$/);
      if (bracketed) {
        bracketed[1].split(",").map((t) => t.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).forEach((t) => tags.add(normalizeTag(t)));
      } else {
        // Single value on same line
        const single = tagsLine[1].trim().replace(/^['"]|['"]$/g, "");
        if (single) tags.add(normalizeTag(single));
      }
    }
    // Block list: tags:\n  - a\n  - b
    const blockTags = yaml.matchAll(/^[\s-]+([^\s#:,[\]{}|>&*!'"]+)$/gm);
    for (const bt of blockTags) {
      const val = bt[1].trim();
      if (val && val !== "tags") tags.add(normalizeTag(val));
    }
  }

  // Inline #tags from body
  let m: RegExpExecArray | null;
  INLINE_TAG_RE.lastIndex = 0;
  while ((m = INLINE_TAG_RE.exec(body)) !== null) {
    tags.add(normalizeTag(m[1]));
  }

  return Array.from(tags).sort();
}

function normalizeTag(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}

// ── Path resolution helpers ───────────────────────────────────────────────────

/**
 * Resolve a wikilink target against the known set of vault paths.
 * Uses the same two-step resolution as the front-end:
 *   1. Exact path match (normalised to .md)
 *   2. Basename match
 * Returns the lower-cased resolved path, or null if unresolved.
 */
function resolveWikilinkTarget(
  target: string,
  pathsLower: Set<string>
): string | null {
  let normalised = target.trim();
  if (!normalised.endsWith(".md")) normalised += ".md";
  const lower = normalised.toLowerCase();

  if (pathsLower.has(lower)) return lower;

  const basename = lower.split("/").pop()!;
  for (const p of pathsLower) {
    if (p.split("/").pop() === basename) return p;
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface IndexFileOptions {
  vaultId: string;
  path: string;
  /** Raw file content; undefined or empty for non-Markdown files */
  content?: string;
  /** All currently known vault paths (for backlink resolution) */
  vaultPaths: string[];
}

/**
 * Index or re-index a single vault file.
 * Replaces any existing FTS row, backlinks, and tags for this path.
 */
export async function indexFile(db: D1Database, opts: IndexFileOptions): Promise<void> {
  const { vaultId, path, content = "", vaultPaths } = opts;

  if (isVaultInternal(path)) return; // never index internals

  const isMarkdown = path.toLowerCase().endsWith(".md");
  const filename = path.split("/").pop() ?? path;
  const pathsLower = new Set(vaultPaths.map((p) => p.toLowerCase()));

  const statements: D1PreparedStatement[] = [];

  // ── FTS ───────────────────────────────────────────────────────────────────

  // Delete existing FTS row for this file, then insert fresh.
  statements.push(
    db.prepare(
      `DELETE FROM vault_fts WHERE vault_id = ? AND path = ?`
    ).bind(vaultId, path.toLowerCase())
  );

  if (isMarkdown && content) {
    // Strip frontmatter YAML from indexed content to avoid YAML noise
    const fmMatch = FM_RE.exec(content);
    const bodyForIndex = fmMatch ? content.slice(fmMatch[0].length).trim() : content;

    statements.push(
      db.prepare(
        `INSERT INTO vault_fts (vault_id, path, filename, content)
         VALUES (?, ?, ?, ?)`
      ).bind(vaultId, path.toLowerCase(), filename, bodyForIndex)
    );
  } else {
    // Index filename only for non-Markdown files
    statements.push(
      db.prepare(
        `INSERT INTO vault_fts (vault_id, path, filename, content)
         VALUES (?, ?, ?, ?)`
      ).bind(vaultId, path.toLowerCase(), filename, "")
    );
  }

  // ── Backlinks ─────────────────────────────────────────────────────────────

  statements.push(
    db.prepare(
      `DELETE FROM backlinks WHERE vault_id = ? AND source_path = ?`
    ).bind(vaultId, path.toLowerCase())
  );

  if (isMarkdown && content) {
    const targets = extractWikilinkTargets(content);
    for (const target of targets) {
      const resolved = resolveWikilinkTarget(target, pathsLower);
      if (resolved) {
        statements.push(
          db.prepare(
            `INSERT OR IGNORE INTO backlinks (vault_id, source_path, target_path)
             VALUES (?, ?, ?)`
          ).bind(vaultId, path.toLowerCase(), resolved)
        );
      }
    }
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  statements.push(
    db.prepare(
      `DELETE FROM note_tags WHERE vault_id = ? AND note_path = ?`
    ).bind(vaultId, path.toLowerCase())
  );

  if (isMarkdown && content) {
    const tags = extractTags(content);
    for (const tag of tags) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO note_tags (vault_id, note_path, tag)
           VALUES (?, ?, ?)`
        ).bind(vaultId, path.toLowerCase(), tag)
      );
    }
  }

  await db.batch(statements);
}

/**
 * Remove all index entries for a deleted file.
 */
export async function removeFromIndex(
  db: D1Database,
  vaultId: string,
  path: string
): Promise<void> {
  if (isVaultInternal(path)) return;

  const lower = path.toLowerCase();
  await db.batch([
    db.prepare(`DELETE FROM vault_fts WHERE vault_id = ? AND path = ?`).bind(vaultId, lower),
    db.prepare(`DELETE FROM backlinks WHERE vault_id = ? AND source_path = ?`).bind(vaultId, lower),
    db.prepare(`DELETE FROM note_tags WHERE vault_id = ? AND note_path = ?`).bind(vaultId, lower),
  ]);
}

/**
 * Rename a file in the index (update path in FTS, backlinks, tags).
 * The old FTS row is deleted and a new one inserted (FTS5 has no UPDATE by rowid
 * in all D1 versions, so delete+insert is safer).
 *
 * Note: backlinks that *point to* oldPath are NOT updated here — resolving them
 * against the new manifest will fix them on next full re-index. For the first
 * slice we only need correctness on newly written content.
 */
export async function renameInIndex(
  db: D1Database,
  vaultId: string,
  oldPath: string,
  newPath: string,
  newContent: string | undefined,
  vaultPaths: string[]
): Promise<void> {
  await removeFromIndex(db, vaultId, oldPath);
  await indexFile(db, { vaultId, path: newPath, content: newContent, vaultPaths });
}
