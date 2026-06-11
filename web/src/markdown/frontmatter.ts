/**
 * Frontmatter extraction using gray-matter.
 * Returns parsed frontmatter data and the body without the YAML block.
 */
import matter from "gray-matter";

export interface FrontmatterResult {
  data: Record<string, unknown>;
  content: string;
  tags: string[];
}

export function parseFrontmatter(source: string): FrontmatterResult {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(source);
  } catch {
    // If frontmatter can't be parsed, treat the whole source as content
    return { data: {}, content: source, tags: [] };
  }

  const data = parsed.data as Record<string, unknown>;
  const tags = extractTags(data, parsed.content);

  return { data, content: parsed.content, tags };
}

/**
 * Extract tags from frontmatter `tags` field and inline `#tag` occurrences.
 */
function extractTags(data: Record<string, unknown>, content: string): string[] {
  const tags = new Set<string>();

  // From frontmatter
  const fmTags = data.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string") tags.add(normalizeTag(t));
    }
  } else if (typeof fmTags === "string") {
    tags.add(normalizeTag(fmTags));
  }

  // Inline #tags (simple extraction — not inside code blocks)
  const inlineTagRe = /(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = inlineTagRe.exec(content)) !== null) {
    tags.add(normalizeTag(m[1]));
  }

  return Array.from(tags).sort();
}

function normalizeTag(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}
