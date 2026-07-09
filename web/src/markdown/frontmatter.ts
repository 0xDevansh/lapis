/**
 * Frontmatter extraction for Obsidian-style YAML blocks.
 * Uses explicit fence detection + js-yaml (gray-matter is unreliable in the browser bundle).
 */
import yaml from "js-yaml";

export interface FrontmatterResult {
  data: Record<string, unknown>;
  content: string;
  tags: string[];
}

const FRONTMATTER_FENCE = /^---\s*$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split a note into YAML frontmatter and body.
 * Always strips a well-formed `---` fence block from the body, even when YAML parsing fails.
 */
export function splitFrontmatter(source: string): { data: Record<string, unknown>; content: string } {
  const text = stripBom(source);
  const lines = text.split(/\r?\n/);

  if (!FRONTMATTER_FENCE.test(lines[0]?.trim() ?? "")) {
    return { data: {}, content: source };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i]?.trim() ?? "")) {
      end = i;
      break;
    }
  }

  if (end < 0) {
    return { data: {}, content: source };
  }

  const yamlText = lines.slice(1, end).join("\n");
  const content = lines.slice(end + 1).join("\n");

  if (!yamlText.trim()) {
    return { data: {}, content };
  }

  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, content };
    }
  } catch {
    // YAML invalid — still strip the fence so raw keys don't render in preview.
  }

  return { data: {}, content };
}

export function parseFrontmatter(source: string): FrontmatterResult {
  const { data, content } = splitFrontmatter(source);
  const tags = extractTags(data, content);
  return { data, content, tags };
}

/**
 * Extract tags from frontmatter `tags` / `tag` fields and inline `#tag` occurrences.
 */
function extractTags(data: Record<string, unknown>, content: string): string[] {
  const tags = new Set<string>();

  const fmTags = data.tags ?? data.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string") tags.add(normalizeTag(t));
    }
  } else if (typeof fmTags === "string") {
    tags.add(normalizeTag(fmTags));
  }

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
