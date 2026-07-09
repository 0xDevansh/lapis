/**
 * Lapis Markdown renderer.
 *
 * Uses `marked` with a custom extension for wikilinks and callouts.
 * Output is sanitized with DOMPurify before insertion into the DOM.
 */
import { marked, type MarkedExtension, type Token } from "marked";
import DOMPurify from "dompurify";
import { fileUrl } from "../api";
import type { ManifestEntry } from "../api";
import { resolveVaultPath, resolveWikilink } from "./wikilinks";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function manifestEntry(
  path: string | null,
  entries?: Record<string, ManifestEntry>
): ManifestEntry | undefined {
  if (!path || !entries) return undefined;
  return entries[path.toLowerCase()];
}

function vaultImageSrc(vaultId: string, path: string, entry?: ManifestEntry): string {
  const base = fileUrl(vaultId, path);
  return entry?.revision != null ? `${base}?rev=${entry.revision}` : base;
}

function renderImageFigure(options: {
  vaultId: string;
  path: string;
  alt: string;
  entry?: ManifestEntry;
  broken?: boolean;
}): string {
  const { vaultId, path, alt, entry, broken } = options;
  const name = path.split("/").pop() ?? path;
  const src = broken ? "" : vaultImageSrc(vaultId, path, entry);
  const metaParts: string[] = [];
  if (entry?.contentType) {
    metaParts.push(entry.contentType.split("/").pop()?.toUpperCase() ?? entry.contentType);
  }
  if (entry?.size != null) metaParts.push(formatBytes(entry.size));

  const showCaption = Boolean(alt && alt !== name && !alt.endsWith(name));
  const captionHtml = showCaption
    ? `<span class="vault-image-caption">${escapeHtml(alt)}</span>`
    : "";
  const detailsHtml =
    metaParts.length > 0
      ? `<span class="vault-image-details">${escapeHtml(metaParts.join(" · "))}</span>`
      : "";

  const figcaption = `<figcaption class="vault-image-meta">${captionHtml}<span class="vault-image-name">${escapeHtml(name)}</span>${detailsHtml}</figcaption>`;

  if (broken) {
    return `<figure class="vault-image-embed vault-image-broken"><div class="vault-image-placeholder">Missing: ${escapeHtml(name)}</div>${figcaption}</figure>`;
  }

  return `<figure class="vault-image-embed"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt || name)}" class="vault-embed-image" loading="lazy" />${figcaption}</figure>`;
}

// ── Wikilink extension ────────────────────────────────────────────────────────

/**
 * Build a marked extension that:
 *   - Replaces [[wikilink]] tokens with <a> tags (resolved or broken)
 *   - Replaces ![[embed]] tokens with image figures or file links
 */
function wikilinkExtension(options: {
  vaultId: string;
  pathByLower: Map<string, string>;
  currentPath?: string;
  manifestEntries?: Record<string, ManifestEntry>;
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

          const resolvedPath = resolveVaultPath(target, options.pathByLower, {
            currentPath: options.currentPath,
          });

          if (isEmbed) {
            if (!resolvedPath) {
              return renderImageFigure({
                vaultId: options.vaultId,
                path: target,
                alt: displayText,
                broken: true,
              });
            }
            if (isImagePath(resolvedPath)) {
              return renderImageFigure({
                vaultId: options.vaultId,
                path: resolvedPath,
                alt: displayText,
                entry: manifestEntry(resolvedPath, options.manifestEntries),
              });
            }
            const href = `/vault/${options.vaultId}/file/${encodeVaultPath(resolvedPath)}`;
            return `<a href="${escapeHtml(href)}" class="wikilink">${escapeHtml(displayText)}</a>`;
          }

          const notePath = resolveWikilink(target, options.pathByLower, {
            currentPath: options.currentPath,
          });

          if (!notePath) {
            const dataPath = encodeURIComponent(
              target.endsWith(".md") ? target : target + ".md"
            );
            return `<a class="wikilink wikilink-broken" title="Note not found — click to create" data-create-path="${dataPath}">${escapeHtml(displayText)}</a>`;
          }

          const href = `/vault/${options.vaultId}/file/${encodeVaultPath(notePath)}${fragment ? "#" + encodeURIComponent(fragment) : ""}`;
          return `<a href="${escapeHtml(href)}" class="wikilink">${escapeHtml(displayText)}</a>`;
        },
      },
    ],
  };
}

// ── Callout post-processing ────────────────────────────────────────────────────

const CALLOUT_TYPES = new Set([
  "note", "tip", "important", "warning", "caution", "danger", "error",
  "info", "success", "question", "quote", "abstract", "summary", "todo",
  "example", "bug", "failure", "missing",
]);

function processCallouts(html: string): string {
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

function resolveMarkdownImageSrc(
  href: string,
  options: {
    vaultId: string;
    pathByLower: Map<string, string>;
    currentPath?: string;
    manifestEntries?: Record<string, ManifestEntry>;
  }
): { path: string | null; src: string; entry?: ManifestEntry } {
  const trimmed = href.trim();
  if (/^(https?:|data:|\/api\/)/i.test(trimmed)) {
    return { path: null, src: trimmed };
  }

  const resolved = resolveVaultPath(trimmed, options.pathByLower, {
    currentPath: options.currentPath,
  });
  if (resolved && isImagePath(resolved)) {
    const entry = manifestEntry(resolved, options.manifestEntries);
    return { path: resolved, src: vaultImageSrc(options.vaultId, resolved, entry), entry };
  }

  return { path: null, src: trimmed };
}

/** Upgrade bare <img> tags from standard markdown ![](...) into vault image figures. */
function processMarkdownImages(
  html: string,
  options: {
    vaultId: string;
    pathByLower: Map<string, string>;
    currentPath?: string;
    manifestEntries?: Record<string, ManifestEntry>;
  }
): string {
  return html.replace(
    /<img([^>]*)\ssrc="([^"]*)"([^>]*)>/gi,
    (match, _before, src, _after) => {
      if (match.includes("vault-embed-image")) return match;

      const altMatch = match.match(/\salt="([^"]*)"/i);
      const alt = altMatch?.[1] ?? "";
      const { path, src: resolvedSrc, entry } = resolveMarkdownImageSrc(src, options);

      if (!path) {
        if (resolvedSrc === src) return match;
        return `<img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(alt)}" class="vault-embed-image" loading="lazy" />`;
      }

      return renderImageFigure({
        vaultId: options.vaultId,
        path,
        alt,
        entry,
      });
    }
  );
}

// ── Public render API ─────────────────────────────────────────────────────────

export interface RenderOptions {
  vaultId: string;
  /** All vault paths (canonical casing). Used for wikilink resolution. */
  vaultPaths: string[];
  /** Path of the note being rendered (for relative image/link resolution). */
  currentPath?: string;
  /** Manifest entries keyed by lower-cased path (for image metadata). */
  manifestEntries?: Record<string, ManifestEntry>;
  onCreateNote?: (path: string) => void;
}

/**
 * Render Markdown source to sanitized HTML.
 * Wikilinks and callouts are processed.
 */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const pathByLower = new Map(options.vaultPaths.map((p) => [p.toLowerCase(), p]));
  const imageOpts = {
    vaultId: options.vaultId,
    pathByLower,
    currentPath: options.currentPath,
    manifestEntries: options.manifestEntries,
  };

  marked.use(wikilinkExtension({ ...imageOpts, onCreateNote: options.onCreateNote }));
  marked.use({ breaks: false, gfm: true });

  const raw = marked.parse(source, { async: false }) as string;
  const withImages = processMarkdownImages(processCallouts(raw), imageOpts);

  return DOMPurify.sanitize(withImages, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li",
      "a", "img",
      "table", "thead", "tbody", "tr", "th", "td",
      "hr",
      "div", "span",
      "figure", "figcaption",
      "time",
    ],
    ALLOWED_ATTR: [
      "href", "title", "src", "alt", "class", "id",
      "data-create-path", "loading", "datetime",
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

function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
