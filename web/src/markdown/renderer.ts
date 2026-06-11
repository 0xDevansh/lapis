/**
 * Lapis Markdown renderer.
 *
 * Uses `marked` with a custom extension for wikilinks and callouts.
 * Output is sanitized with DOMPurify before insertion into the DOM.
 */
import { marked, type MarkedExtension, type Token } from "marked";
import DOMPurify from "dompurify";
import { resolveWikilink } from "./wikilinks";

// ── Wikilink extension ────────────────────────────────────────────────────────

/**
 * Build a marked extension that:
 *   - Replaces [[wikilink]] tokens with <a> tags (resolved or broken)
 *   - Replaces ![[embed]] tokens with <img> or a file-link fallback
 */
function wikilinkExtension(options: {
  vaultId: string;
  pathsLower: Set<string>;
  onCreateNote?: (path: string) => void;
}): MarkedExtension {
  return {
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start(src: string) {
          return src.indexOf("[[");
        },
        tokenizer(src: string) {
          // Match [[...]] optionally preceded by !
          const match = /^(!?)\[\[([^\]]+?)\]\]/.exec(src);
          if (!match) return undefined;
          return {
            type: "wikilink",
            raw: match[0],
            isEmbed: match[1] === "!",
            inner: match[2],
          };
        },
        renderer(token: Token & { isEmbed?: boolean; inner?: string }) {
          const isEmbed = token.isEmbed ?? false;
          const inner = token.inner ?? "";

          // Parse inner: [[target#fragment|alias]]
          const pipeIdx = inner.indexOf("|");
          let refPart = pipeIdx !== -1 ? inner.slice(0, pipeIdx).trim() : inner.trim();
          const alias = pipeIdx !== -1 ? inner.slice(pipeIdx + 1).trim() : "";

          const hashIdx = refPart.indexOf("#");
          const fragment = hashIdx !== -1 ? refPart.slice(hashIdx + 1).trim() : "";
          const target = hashIdx !== -1 ? refPart.slice(0, hashIdx).trim() : refPart;

          let displayText = alias;
          if (!displayText) {
            displayText = target.split("/").pop() ?? target;
            if (displayText.endsWith(".md")) displayText = displayText.slice(0, -3);
            if (fragment) displayText += ` > ${fragment}`;
          }

          const resolvedPath = resolveWikilink(target, options.pathsLower);

          // ── Embed (![[...]]) ─────────────────────────────────────────────
          if (isEmbed) {
            if (!resolvedPath) {
              return `<span class="wikilink-broken" title="File not found: ${escapeHtml(target)}">${escapeHtml(displayText)}</span>`;
            }
            const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
            const imgExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
            if (imgExts.includes(ext)) {
              const src = `/api/vaults/${options.vaultId}/files/${resolvedPath}`;
              return `<img src="${src}" alt="${escapeHtml(displayText)}" class="vault-embed-image" loading="lazy" />`;
            }
            // Non-image embed — show as a link
            const href = `/vault/${options.vaultId}/${resolvedPath}`;
            return `<a href="${escapeHtml(href)}" class="wikilink">${escapeHtml(displayText)}</a>`;
          }

          // ── Regular wikilink ─────────────────────────────────────────────
          if (!resolvedPath) {
            // Broken link
            const dataPath = encodeURIComponent(
              target.endsWith(".md") ? target : target + ".md"
            );
            return `<a class="wikilink wikilink-broken" title="Note not found — click to create" data-create-path="${dataPath}">${escapeHtml(displayText)}</a>`;
          }

          const href = `/vault/${options.vaultId}/${resolvedPath}${fragment ? "#" + encodeURIComponent(fragment) : ""}`;
          return `<a href="${escapeHtml(href)}" class="wikilink">${escapeHtml(displayText)}</a>`;
        },
      },
    ],
  };
}

// ── Callout post-processing ────────────────────────────────────────────────────
//
// Obsidian callouts look like:
//   > [!NOTE] Optional title
//   > Content here
//
// marked converts them to <blockquote>. We post-process the HTML to wrap them.

const CALLOUT_TYPES = new Set([
  "note", "tip", "important", "warning", "caution", "danger", "error",
  "info", "success", "question", "quote", "abstract", "summary", "todo",
  "example", "bug", "failure", "missing",
]);

function processCallouts(html: string): string {
  // Replace <blockquote> starting with <p>[!TYPE]
  return html.replace(
    /<blockquote>\s*<p>\[!(\w+)\]([^\n<]*)/gi,
    (_, type, titleRest) => {
      const calloutType = type.toLowerCase();
      const isKnown = CALLOUT_TYPES.has(calloutType);
      const displayType = isKnown ? calloutType : "note";
      const titleText = titleRest.trim();
      const title = titleText
        ? `<div class="callout-title"><span class="callout-icon">${calloutIcon(displayType)}</span><span>${escapeHtml(titleText)}</span></div>`
        : `<div class="callout-title"><span class="callout-icon">${calloutIcon(displayType)}</span><span>${type}</span></div>`;
      return `<div class="callout callout-${displayType}">${title}<div class="callout-body"><p>`;
    }
  ).replace(/<\/blockquote>/gi, "</p></div></div>");
}

function calloutIcon(type: string): string {
  const icons: Record<string, string> = {
    note: "📝", tip: "💡", important: "❗", warning: "⚠️", caution: "⚠️",
    danger: "🔥", error: "❌", info: "ℹ️", success: "✅", question: "❓",
    quote: "💬", abstract: "📋", summary: "📋", todo: "☑️", example: "🔬",
    bug: "🐛", failure: "❌", missing: "❓",
  };
  return icons[type] ?? "📝";
}

// ── Public render API ─────────────────────────────────────────────────────────

export interface RenderOptions {
  vaultId: string;
  /** All vault paths (canonical casing). Used for wikilink resolution. */
  vaultPaths: string[];
  onCreateNote?: (path: string) => void;
}

/**
 * Render Markdown source to sanitized HTML.
 * Wikilinks and callouts are processed.
 */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const pathsLower = new Set(options.vaultPaths.map((p) => p.toLowerCase()));

  // Register wikilink extension (stateless per call)
  marked.use(wikilinkExtension({ vaultId: options.vaultId, pathsLower }));
  marked.use({ breaks: false, gfm: true });

  const raw = marked.parse(source, { async: false }) as string;
  const withCallouts = processCallouts(raw);

  return DOMPurify.sanitize(withCallouts, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li",
      "a", "img",
      "table", "thead", "tbody", "tr", "th", "td",
      "hr",
      "div", "span",
    ],
    ALLOWED_ATTR: [
      "href", "title", "src", "alt", "class", "id",
      "data-create-path", "loading",
      "colspan", "rowspan",
    ],
    ALLOW_DATA_ATTR: true,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
