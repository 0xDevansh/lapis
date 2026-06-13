/**
 * Obsidian-style "Live Preview" decorations for CodeMirror 6.
 *
 * The plugin walks the Lezer markdown syntax tree (plus a regex pass for
 * Obsidian wikilinks/embeds, which Lezer does not parse) and:
 *   - hides formatting marks (#, **, _, `, ~~, link brackets/urls) on lines
 *     the cursor is NOT on, while keeping them visible on the active line(s)
 *     so you can edit the raw markdown;
 *   - applies styling marks (heading sizes, bold, italic, code, strike, quote);
 *   - replaces [[wikilink]] / ![[embed]] with clickable widgets when not being
 *     edited.
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
import { tokenize, resolveWikilink } from "../../markdown/wikilinks";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

export interface LivePreviewConfig {
  /** Build a /api/.../files/<path> url for an embedded attachment. */
  fileUrl: (path: string) => string;
  /** Lower-cased path -> canonical path map for resolving wikilinks. */
  pathMap: Map<string, string>;
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

        // Lines that hold the cursor/selection — reveal raw markdown there.
        const revealed = new Set<number>();
        for (const r of state.selection.ranges) {
          const a = state.doc.lineAt(r.from).number;
          const b = state.doc.lineAt(r.to).number;
          for (let l = a; l <= b; l++) revealed.add(l);
        }
        const lineRevealed = (pos: number) =>
          revealed.has(state.doc.lineAt(pos).number);

        // Track wikilink ranges so tree marks inside them are skipped.
        const occupied: Array<[number, number]> = [];
        const overlaps = (from: number, to: number) =>
          occupied.some(([a, b]) => from < b && to > a);

        for (const { from, to } of view.visibleRanges) {
          // --- Wikilinks / embeds (regex; Lezer doesn't parse them) ----------
          const text = state.doc.sliceString(from, to);
          const re = /(!?)\[\[([^\]]+?)\]\]/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const start = from + m.index;
            const end = start + m[0].length;
            occupied.push([start, end]);
            if (lineRevealed(start)) continue; // editing this line -> show raw
            const tok = tokenize(m);
            if (tok.isEmbed && isImageTarget(tok.target)) {
              const resolved =
                resolveWikilink(tok.target, config.pathMap) ?? tok.target;
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
              const resolved = resolveWikilink(tok.target, config.pathMap);
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

          // --- Syntax tree pass ---------------------------------------------
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              const name = node.name;
              const nFrom = node.from;
              const nTo = node.to;
              if (overlaps(nFrom, nTo)) return;

              // Headings: style the whole line, hide the leading "# " marks.
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
