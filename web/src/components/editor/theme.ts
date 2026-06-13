import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Dark editor theme wired to the app's design tokens (CSS variables defined in
 * index.css). Transparent background so it sits on bg-canvas.
 */
export const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--ink)",
      backgroundColor: "transparent",
      height: "100%",
      fontSize: "15px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      lineHeight: "1.7",
      padding: "20px 0",
    },
    ".cm-content": {
      caretColor: "var(--accent-soft)",
      maxWidth: "820px",
      margin: "0 auto",
      padding: "0 32px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent-soft)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-selectionBackground, & ::selection":
      {
        background:
          "color-mix(in srgb, var(--accent) 32%, transparent) !important",
      },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-line": { padding: "0" },

    // Live-preview styling marks
    ".cm-heading": { fontWeight: "700", color: "var(--ink)", lineHeight: "1.3" },
    ".cm-heading-1": { fontSize: "1.9em" },
    ".cm-heading-2": { fontSize: "1.55em" },
    ".cm-heading-3": { fontSize: "1.3em" },
    ".cm-heading-4": { fontSize: "1.15em" },
    ".cm-heading-5": { fontSize: "1.05em" },
    ".cm-heading-6": { fontSize: "1em", color: "var(--muted)" },
    ".cm-strong": { fontWeight: "700", color: "var(--ink)" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-strike": { textDecoration: "line-through", color: "var(--muted)" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono, monospace)",
      backgroundColor: "var(--code-bg)",
      color: "var(--accent-soft)",
      padding: "0.1em 0.35em",
      borderRadius: "4px",
      fontSize: "0.92em",
    },
    ".cm-link": { color: "var(--accent-soft)" },
    ".cm-wikilink": {
      color: "var(--accent-soft)",
      cursor: "pointer",
      textDecoration: "none",
      borderBottom: "1px solid color-mix(in srgb, var(--accent-soft) 40%, transparent)",
    },
    ".cm-wikilink:hover": {
      color: "var(--accent)",
      borderBottomColor: "var(--accent)",
    },
    ".cm-wikilink-broken": {
      color: "#d8729e",
      borderBottomStyle: "dotted",
    },
    ".cm-embed-image-wrap": { padding: "6px 0" },
    ".cm-embed-image": {
      maxWidth: "100%",
      borderRadius: "8px",
      display: "block",
    },
  },
  { dark: true }
);

/** Syntax highlighting for fenced code blocks and markdown tokens. */
export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "#c792ea" },
    { tag: [t.name, t.deleted, t.character, t.propertyName], color: "#82aaff" },
    { tag: [t.function(t.variableName), t.labelName], color: "#82aaff" },
    { tag: [t.string, t.inserted], color: "#c3e88d" },
    { tag: [t.number, t.bool, t.null], color: "#f78c6c" },
    { tag: [t.comment, t.meta], color: "var(--faint)", fontStyle: "italic" },
    { tag: [t.typeName, t.className], color: "#ffcb6b" },
    { tag: [t.operator, t.punctuation], color: "var(--muted)" },
    { tag: t.tagName, color: "#f07178" },
    { tag: t.attributeName, color: "#c792ea" },
    { tag: t.invalid, color: "var(--danger)" },
  ])
);
