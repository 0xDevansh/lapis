/**
 * Lapis Markdown renderer.
 *
 * Uses `marked` with extensions for wikilinks, callouts, highlights, comments,
 * and KaTeX math — aligned with Obsidian Flavored Markdown basics.
 * Output is sanitized with DOMPurify before insertion into the DOM.
 */
import { Marked, type MarkedExtension, type Token } from "marked";
import markedKatex from "marked-katex-extension";
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
  width?: number;
  height?: number;
}): string {
  const { vaultId, path, alt, entry, broken, width, height } = options;
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
  const sizeAttr =
    width != null
      ? ` width="${width}"${height != null ? ` height="${height}"` : ""} style="width:${width}px;${height != null ? `height:${height}px;` : "height:auto;"}"`
      : "";

  if (broken) {
    return `<figure class="vault-image-embed vault-image-broken"><div class="vault-image-placeholder">Missing: ${escapeHtml(name)}</div>${figcaption}</figure>`;
  }

  return `<figure class="vault-image-embed"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt || name)}" class="vault-embed-image"${sizeAttr} loading="lazy" />${figcaption}</figure>`;
}

/** Parse Obsidian-style image size from alias: `alt|640x480` or `alt|100`. */
function parseSizeAlias(alias: string): { alt: string; width?: number; height?: number } {
  const m = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(alias);
  if (!m) return { alt: alias };
  return {
    alt: m[1].trim(),
    width: Number(m[2]),
    height: m[3] ? Number(m[3]) : undefined,
  };
}

function wikilinkExtension(options: {
  vaultId: string;
  pathByLower: Map<string, string>;
  currentPath?: string;
  manifestEntries?: Record<string, ManifestEntry>;
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
            const sized = parseSizeAlias(displayText);
            if (!resolvedPath) {
              return renderImageFigure({
                vaultId: options.vaultId,
                path: target,
                alt: sized.alt,
                broken: true,
                width: sized.width,
                height: sized.height,
              });
            }
            if (isImagePath(resolvedPath)) {
              return renderImageFigure({
                vaultId: options.vaultId,
                path: resolvedPath,
                alt: sized.alt || displayText,
                entry: manifestEntry(resolvedPath, options.manifestEntries),
                width: sized.width,
                height: sized.height,
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

/** Obsidian ==highlight== */
function highlightExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: "highlight",
        level: "inline",
        start(src: string) {
          return src.indexOf("==");
        },
        tokenizer(src: string) {
          const match = /^==([^=]+?)==/.exec(src);
          if (!match) return undefined;
          return {
            type: "highlight",
            raw: match[0],
            text: match[1],
            tokens: this.lexer.inlineTokens(match[1]),
          };
        },
        renderer(token: Token & { tokens?: Token[] }) {
          return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
        },
      },
    ],
  };
}

/** Strip Obsidian %%comments%% (hidden in reading view). */
function stripComments(source: string): string {
  return source.replace(/%%[\s\S]*?%%/g, "");
}

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
    (match, _before, src) => {
      if (match.includes("vault-embed-image")) return match;

      const altMatch = match.match(/\salt="([^"]*)"/i);
      const rawAlt = altMatch?.[1] ?? "";
      const sized = parseSizeAlias(rawAlt);
      const { path, src: resolvedSrc, entry } = resolveMarkdownImageSrc(src, options);

      if (!path) {
        if (resolvedSrc === src && sized.width == null) return match;
        const sizeAttr =
          sized.width != null
            ? ` width="${sized.width}"${sized.height != null ? ` height="${sized.height}"` : ""} style="width:${sized.width}px;${sized.height != null ? `height:${sized.height}px;` : "height:auto;"}"`
            : "";
        return `<img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(sized.alt)}" class="vault-embed-image"${sizeAttr} loading="lazy" />`;
      }

      return renderImageFigure({
        vaultId: options.vaultId,
        path,
        alt: sized.alt,
        entry,
        width: sized.width,
        height: sized.height,
      });
    }
  );
}

export interface RenderOptions {
  vaultId: string;
  vaultPaths: string[];
  currentPath?: string;
  manifestEntries?: Record<string, ManifestEntry>;
  onCreateNote?: (path: string) => void;
}

/**
 * Render Markdown source to sanitized HTML.
 * Wikilinks, callouts, highlights, and KaTeX math are processed.
 */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const pathByLower = new Map(
    (options.vaultPaths ?? []).map((p) => [p.toLowerCase(), p])
  );
  const imageOpts = {
    vaultId: options.vaultId,
    pathByLower,
    currentPath: options.currentPath,
    manifestEntries: options.manifestEntries,
  };

  const cleaned = stripComments(source);

  // Fresh Marked instance per render so vault-scoped extensions don't stack.
  const md = new Marked();
  md.use(
    markedKatex({
      throwOnError: false,
      nonStandard: true,
    })
  );
  md.use(highlightExtension());
  md.use(wikilinkExtension(imageOpts));
  md.use({ breaks: false, gfm: true });

  const raw = md.parse(cleaned, { async: false }) as string;
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
      "mark",
      "input",
      "sup", "sub",
      "annotation", "semantics", "math", "mrow", "mi", "mo", "mn",
      "msup", "msub", "mfrac", "msqrt", "mroot", "mtable", "mtr", "mtd",
      "mspace", "mtext", "mover", "munder", "munderover",
    ],
    ALLOWED_ATTR: [
      "href", "title", "src", "alt", "class", "id",
      "data-create-path", "loading", "datetime",
      "colspan", "rowspan",
      "width", "height", "style",
      "type", "checked", "disabled",
      "aria-hidden", "xmlns",
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
