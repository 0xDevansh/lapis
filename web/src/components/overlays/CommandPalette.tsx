import { useEffect, useMemo, useRef, useState } from "react";
import {
  MagnifyingGlass,
  FileText,
  ArrowBendDownLeft,
} from "@phosphor-icons/react";

export type PaletteMode = "commands" | "files";

export interface Command {
  id: string;
  title: string;
  hint?: string;
  /** Extra words to match against. */
  keywords?: string;
  icon?: React.ReactNode;
  run: () => void;
}

interface Row {
  key: string;
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void;
}

// Subsequence fuzzy match. Returns a score (higher = better) or null if no match.
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = prevIdx === ti - 1 ? streak + 1 : 1;
      // Bonus for consecutive matches and word boundaries.
      score += 1 + streak;
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === " " || t[ti - 1] === "-")
        score += 3;
      prevIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score - text.length * 0.01 : null;
}

function basename(path: string): string {
  const b = path.split("/").pop() ?? path;
  return b.endsWith(".md") ? b.slice(0, -3) : b;
}

export default function CommandPalette({
  mode,
  commands,
  files,
  onOpenFile,
  onClose,
}: {
  mode: PaletteMode;
  commands: Command[];
  files: string[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);

  // Reset selection when query changes.
  useEffect(() => setActive(0), [query, mode]);

  const rows = useMemo<Row[]>(() => {
    if (mode === "files") {
      const scored = files
        .map((path) => ({ path, s: fuzzyScore(query, path) }))
        .filter((x) => x.s !== null) as { path: string; s: number }[];
      scored.sort((a, b) => b.s - a.s);
      return scored.slice(0, 50).map((x) => ({
        key: x.path,
        label: basename(x.path),
        sublabel: x.path,
        icon: <FileText size={16} className="text-accent-soft" />,
        run: () => {
          onOpenFile(x.path);
          onClose();
        },
      }));
    }
    const scored = commands
      .map((c) => ({ c, s: fuzzyScore(query, `${c.title} ${c.keywords ?? ""}`) }))
      .filter((x) => x.s !== null) as { c: Command; s: number }[];
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => ({
      key: x.c.id,
      label: x.c.title,
      hint: x.c.hint,
      icon: x.c.icon ?? <span className="h-4 w-4" />,
      run: () => {
        x.c.run();
        onClose();
      },
    }));
  }, [mode, query, files, commands, onOpenFile, onClose]);

  // Keep active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[active]?.run();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Quick switcher" : "Command palette"}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <MagnifyingGlass size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === "files"
                ? "Go to file…"
                : "Type a command…"
            }
            className="w-full bg-transparent py-3 text-sm text-ink outline-none placeholder:text-faint"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[active] ? `palette-row-${active}` : undefined}
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint sm:block">
            esc
          </kbd>
        </div>
        <div
          ref={listRef}
          id="palette-list"
          role="listbox"
          className="custom-scroll min-h-0 flex-1 overflow-y-auto py-1"
        >
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-faint">
              No matches.
            </p>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.key}
                id={`palette-row-${i}`}
                data-idx={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={row.run}
                className={[
                  "flex w-full items-center gap-3 px-4 py-2 text-left",
                  i === active ? "bg-accent/15 text-ink" : "text-muted",
                ].join(" ")}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {row.icon}
                </span>
                <span className="flex-1 truncate text-[13px]">
                  {row.label}
                  {row.sublabel && (
                    <span className="ml-2 truncate font-mono text-[11px] text-faint">
                      {row.sublabel}
                    </span>
                  )}
                </span>
                {row.hint && (
                  <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint">
                    {row.hint}
                  </kbd>
                )}
                {i === active && (
                  <ArrowBendDownLeft size={13} className="shrink-0 text-faint" />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
