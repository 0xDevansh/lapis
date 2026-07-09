/**
 * Wikilink utilities for Obsidian-style [[...]] links.
 *
 * Supported syntax:
 *   [[Note]]           → links to "Note.md" in the vault
 *   [[Note|Alias]]     → links with display text "Alias"
 *   [[Note#Heading]]   → links to a heading anchor (resolved as file + hash)
 *   [[Note#Heading|Label]]
 *   ![[image.png]]     → attachment embed
 */

export interface WikilinkToken {
  raw: string;       // full match including [[...]]
  target: string;    // file target (without # fragment)
  fragment: string;  // heading fragment (without #), may be ""
  alias: string;     // display text — equals target if not specified
  isEmbed: boolean;  // true if prefixed with !
}

const WIKILINK_RE = /(!?)\[\[([^\]]+?)\]\]/g;

export function parseWikilinks(source: string): WikilinkToken[] {
  const results: WikilinkToken[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(source)) !== null) {
    results.push(tokenize(match));
  }
  return results;
}

export function tokenize(match: RegExpExecArray): WikilinkToken {
  const isEmbed = match[1] === "!";
  const inner = match[2]; // everything between [[ and ]]

  // Split alias: [[target|alias]]
  const pipeIdx = inner.indexOf("|");
  let refPart: string;
  let alias: string;

  if (pipeIdx !== -1) {
    refPart = inner.slice(0, pipeIdx).trim();
    alias = inner.slice(pipeIdx + 1).trim();
  } else {
    refPart = inner.trim();
    alias = "";
  }

  // Split fragment: target#heading
  const hashIdx = refPart.indexOf("#");
  let target: string;
  let fragment: string;

  if (hashIdx !== -1) {
    target = refPart.slice(0, hashIdx).trim();
    fragment = refPart.slice(hashIdx + 1).trim();
  } else {
    target = refPart;
    fragment = "";
  }

  if (!alias) {
    // Default display: show filename without path and extension
    alias = target.split("/").pop() ?? target;
    if (alias.endsWith(".md")) alias = alias.slice(0, -3);
    if (fragment) alias += ` > ${fragment}`;
  }

  return { raw: match[0], target, fragment, alias, isEmbed };
}

type PathIndex = Set<string> | Map<string, string>;

function lookupExact(lowerPath: string, paths: PathIndex): string | null {
  if (paths instanceof Map) {
    return paths.get(lowerPath) ?? null;
  }
  return paths.has(lowerPath) ? lowerPath : null;
}

function lookupBasename(basename: string, paths: PathIndex): string | null {
  for (const [lowerPath, canonicalPath] of paths instanceof Map
    ? paths
    : Array.from(paths, (p) => [p, p] as const)) {
    if (lowerPath.split("/").pop() === basename) return canonicalPath;
  }
  return null;
}

function hasFileExtension(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1;
}

function buildCandidates(target: string, currentPath?: string): string[] {
  const trimmed = target.trim().replace(/^\.\//, "");
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (p: string) => {
    const key = p.toLowerCase();
    if (!p || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  if (currentPath) {
    const dir = currentPath.includes("/")
      ? currentPath.slice(0, currentPath.lastIndexOf("/"))
      : "";
    if (!trimmed.startsWith("/")) {
      push(dir ? `${dir}/${trimmed}` : trimmed);
    }
  }

  push(trimmed.startsWith("/") ? trimmed.slice(1) : trimmed);
  return out;
}

/**
 * Resolve a vault-relative path (note, attachment, or image) against known paths.
 *
 * Resolution order:
 *   1. Exact match for each candidate path (relative to current note, then as given)
 *   2. Append `.md` when the target has no extension
 *   3. Basename match anywhere in the vault
 */
export function resolveVaultPath(
  target: string,
  paths: PathIndex,
  options?: { currentPath?: string }
): string | null {
  for (const candidate of buildCandidates(target, options?.currentPath)) {
    const exact = lookupExact(candidate.toLowerCase(), paths);
    if (exact) return exact;

    if (!hasFileExtension(candidate)) {
      const withMd = lookupExact(`${candidate}.md`.toLowerCase(), paths);
      if (withMd) return withMd;
    }
  }

  const basename = target.trim().split("/").pop()?.toLowerCase() ?? "";
  if (!basename) return null;

  if (hasFileExtension(basename)) {
    return lookupBasename(basename, paths);
  }

  return lookupBasename(`${basename}.md`, paths);
}

/**
 * Resolve a wikilink target to a vault path.
 * Notes without an extension are normalised to `.md`; attachments keep their extension.
 */
export function resolveWikilink(
  target: string,
  paths: PathIndex,
  options?: { currentPath?: string }
): string | null {
  return resolveVaultPath(target, paths, options);
}
