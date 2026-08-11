/**
 * Obsidian-style "Live Preview" decorations for CodeMirror 6.
 *
 * The plugin walks the Lezer markdown syntax tree (plus a regex pass for
 * Obsidian wikilinks/embeds and TeX, which Lezer does not parse) and:
 *   - hides formatting marks (#, **, _, `, ~~, link brackets/urls) on lines
 *     the cursor is NOT on, while keeping them visible on the active line(s)
 *     so you can edit the raw markdown;
 *   - applies styling marks (heading sizes, bold, italic, code, strike, quote);
 *   - replaces [[wikilink]] / ![[embed]] / $math$ with widgets when not being
 *     edited (TeX becomes raw source when the cursor is over it).
 */
import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import katex from "katex";
import { tokenize, resolveVaultPath, resolveWikilink } from "../../markdown/wikilinks";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

export interface LivePreviewConfig {
  /** Build a /api/.../files/<path> url for an embedded attachment. */
  fileUrl: (path: string) => string;
  /** Lower-cased path -> canonical path map for resolving wikilinks. */
  pathMap: Map<string, string>;
  /** Path of the note being edited (for relative embed resolution). */
  currentPath?: string;
  /** Open a vault file by (resolved) path. */
  onOpenLink: (path: string) => void;
}

class WikiLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly display: string,
    readonly broken: boolean,
    readonly onOpen: () => void
  ) {
    super();
  }
  eq(other: WikiLinkWidget) {
    return (
      other.target === this.target &&
      other.display === this.display &&
      other.broken === this.broken
    );
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-wikilink" + (this.broken ? " cm-wikilink-broken" : "");
    el.textContent = this.display;
    el.title = this.target;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.onOpen();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageEmbedWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(other: ImageEmbedWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-image-wrap";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-embed-image";
    wrap.appendChild(img);
    return wrap;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.displayMode === this.displayMode;
  }
  toDOM() {
    const el = document.createElement(this.displayMode ? "div" : "span");
    el.className = this.displayMode ? "cm-math cm-math-block" : "cm-math";
    try {
      katex.render(this.tex, el, {
        throwOnError: false,
        displayMode: this.displayMode,
      });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function isImageTarget(target: string): boolean {
  const ext = target.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

const headingMark = (level: number) =>
  Decoration.line({ class: `cm-heading cm-heading-${level}` });
const HIDE = Decoration.replace({});
const STRONG = Decoration.mark({ class: "cm-strong" });
const EM = Decoration.mark({ class: "cm-em" });
const STRIKE = Decoration.mark({ class: "cm-strike" });
const INLINE_CODE = Decoration.mark({ class: "cm-inline-code" });
const LINK = Decoration.mark({ class: "cm-link" });

/** Find $...$ / $$...$$ ranges, skipping code spans. */
function findMathRanges(
  text: string
): Array<{ from: number; to: number; tex: string; display: boolean }> {
  const out: Array<{ from: number; to: number; tex: string; display: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("$$", i)) {
      const end = text.indexOf("$$", i + 2);
      if (end !== -1) {
        out.push({ from: i, to: end + 2, tex: text.slice(i + 2, end), display: true });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "$" && text[i + 1] !== "$") {
      let j = i + 1;
      while (j < text.length && text[j] !== "$" && text[j] !== "\n") j++;
      if (text[j] === "$" && j > i + 1) {
        out.push({ from: i, to: j + 1, tex: text.slice(i + 1, j), display: false });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

export function livePreview(config: LivePreviewConfig) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const { state } = view;
        const deco: Range<Decoration>[] = [];

        const revealed = new Set<number>();
        const selectionTouches = (from: number, to: number) => {
          for (const r of state.selection.ranges) {
            if (r.from <= to && r.to >= from) return true;
          }
          return false;
        };
        for (const r of state.selection.ranges) {
          const a = state.doc.lineAt(r.from).number;
          const b = state.doc.lineAt(r.to).number;
          for (let l = a; l <= b; l++) revealed.add(l);
        }
        const lineRevealed = (pos: number) =>
          revealed.has(state.doc.lineAt(pos).number);

        const occupied: Array<[number, number]> = [];
        const overlaps = (from: number, to: number) =>
          occupied.some(([a, b]) => from < b && to > a);

        for (const { from, to } of view.visibleRanges) {
          const text = state.doc.sliceString(from, to);

          for (const m of findMathRanges(text)) {
            const start = from + m.from;
            const end = from + m.to;
            occupied.push([start, end]);
            if (selectionTouches(start, end) || lineRevealed(start)) continue;
            deco.push(
              Decoration.replace({
                widget: new MathWidget(m.tex.trim(), m.display),
                block: m.display,
              }).range(start, end)
            );
          }

          const re = /(!?)\[\[([^\]]+?)\]\]/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (overlaps(start, end)) continue;
            occupied.push([start, end]);
            if (lineRevealed(start)) continue;
            const tok = tokenize(m);
            if (tok.isEmbed && isImageTarget(tok.target)) {
              const resolved =
                resolveVaultPath(tok.target, config.pathMap, {
                  currentPath: config.currentPath,
                }) ?? tok.target;
              deco.push(
                Decoration.replace({
                  widget: new ImageEmbedWidget(
                    config.fileUrl(resolved),
                    tok.alias
                  ),
                  block: false,
                }).range(start, end)
              );
            } else {
              const resolved = resolveWikilink(tok.target, config.pathMap, {
                currentPath: config.currentPath,
              });
              const open = () =>
                config.onOpenLink(
                  resolved ??
                    (tok.target.endsWith(".md")
                      ? tok.target
                      : tok.target + ".md")
                );
              deco.push(
                Decoration.replace({
                  widget: new WikiLinkWidget(
                    tok.target,
                    tok.alias,
                    resolved === null,
                    open
                  ),
                }).range(start, end)
              );
            }
          }

          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              const name = node.name;
              const nFrom = node.from;
              const nTo = node.to;
              if (overlaps(nFrom, nTo)) return;

              const hMatch = /^ATXHeading(\d)$/.exec(name);
              if (hMatch) {
                const level = Number(hMatch[1]);
                const line = state.doc.lineAt(nFrom);
                deco.push(headingMark(level).range(line.from));
                return;
              }
              if (name === "HeaderMark") {
                if (!lineRevealed(nFrom)) {
                  let end = nTo;
                  if (state.doc.sliceString(end, end + 1) === " ") end += 1;
                  deco.push(HIDE.range(nFrom, end));
                }
                return;
              }

              if (name === "StrongEmphasis") {
                deco.push(STRONG.range(nFrom, nTo));
                return;
              }
              if (name === "Emphasis") {
                deco.push(EM.range(nFrom, nTo));
                return;
              }
              if (name === "Strikethrough") {
                deco.push(STRIKE.range(nFrom, nTo));
                return;
              }
              if (name === "InlineCode") {
                deco.push(INLINE_CODE.range(nFrom, nTo));
                return;
              }
              if (
                name === "EmphasisMark" ||
                name === "StrikethroughMark" ||
                name === "CodeMark"
              ) {
                if (!lineRevealed(nFrom)) deco.push(HIDE.range(nFrom, nTo));
                return;
              }

              if (name === "Link") {
                deco.push(LINK.range(nFrom, nTo));
                return;
              }
              if (name === "LinkMark" || name === "URL") {
                if (!lineRevealed(nFrom)) deco.push(HIDE.range(nFrom, nTo));
                return;
              }
            },
          });
        }

        deco.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
        return Decoration.set(deco, true);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
