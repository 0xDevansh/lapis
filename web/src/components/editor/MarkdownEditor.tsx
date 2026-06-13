import { useEffect, useMemo, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { editorTheme, editorHighlight } from "./theme";
import { livePreview } from "./livePreview";

interface MarkdownEditorProps {
  /** The file path — used as a key to know when to fully reset the document. */
  docKey: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Apply Obsidian live-preview decorations (markdown files only). */
  livePreviewEnabled: boolean;
  vaultId: string;
  vaultPaths: string[];
  onOpenLink: (path: string) => void;
  fileUrl: (vaultId: string, path: string) => string;
}

export default function MarkdownEditor({
  docKey,
  value,
  onChange,
  onSave,
  livePreviewEnabled,
  vaultId,
  vaultPaths,
  onOpenLink,
  fileUrl,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep the latest callbacks/data without rebuilding the editor each render.
  const cbRef = useRef({ onChange, onSave, onOpenLink, vaultPaths, vaultId });
  cbRef.current = { onChange, onSave, onOpenLink, vaultPaths, vaultId };

  const pathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of vaultPaths) map.set(p.toLowerCase(), p);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPaths.join("\u0000")]);

  // Build / rebuild the editor when the document identity or mode changes.
  useEffect(() => {
    if (!hostRef.current) return;

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            cbRef.current.onSave();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      editorTheme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cbRef.current.onChange(u.state.doc.toString());
      }),
    ];

    if (livePreviewEnabled) {
      extensions.push(
        editorHighlight,
        livePreview({
          fileUrl: (path: string) => fileUrl(cbRef.current.vaultId, path),
          pathMap,
          onOpenLink: (path: string) => cbRef.current.onOpenLink(path),
        })
      );
    } else {
      extensions.push(syntaxHighlighting(defaultHighlightStyle));
    }

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, livePreviewEnabled, pathMap]);

  // Sync external value changes (remote edits, saves) into the editor without
  // disturbing the cursor when the change originated locally.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="custom-scroll min-h-0 flex-1 overflow-y-auto bg-canvas"
    />
  );
}
