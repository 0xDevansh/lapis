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

/**
 * Given a wikilink target (e.g. "MyNote", "folder/MyNote") and the set of
 * all known vault paths (lower-cased), return the matching path or null.
 *
 * Obsidian resolution order:
 *   1. Exact path match (with or without .md)
 *   2. Basename-only match anywhere in the vault
 */
export function resolveWikilink(
  target: string,
  paths: Set<string> | Map<string, string>
): string | null {
  // Normalize: treat the target as potentially relative or absolute
  let normalised = target.trim();
  if (!normalised.endsWith(".md")) normalised += ".md";

  const lowerTarget = normalised.toLowerCase();

  // 1. Exact match
  if (paths instanceof Map) {
    const exact = paths.get(lowerTarget);
    if (exact) return exact;
  } else if (paths.has(lowerTarget)) {
    return lowerTarget;
  }

  // 2. Basename match
  const basename = lowerTarget.split("/").pop()!;
  for (const [lowerPath, canonicalPath] of paths instanceof Map ? paths : Array.from(paths, (p) => [p, p] as const)) {
    if (lowerPath.split("/").pop() === basename) return canonicalPath;
  }

  return null;
}
