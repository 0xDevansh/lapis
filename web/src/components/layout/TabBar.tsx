import { useRef } from "react";
import { X, FileText, Image as ImageIcon, File } from "@phosphor-icons/react";
import { useWorkspace, type Tab } from "../../store/workspace";

interface TabBarProps {
  /** Resolve a path to a content-type hint for picking the tab icon. */
  contentTypeFor: (path: string) => string | undefined;
  /** Request to close a tab; parent guards unsaved edits. */
  onCloseTab: (id: string) => void;
}

function basename(path: string): string {
  const seg = path.split("/").pop() ?? path;
  return seg.replace(/\.md$/i, "");
}

function TabIcon({ path, contentType }: { path: string; contentType?: string }) {
  if (contentType?.startsWith("image/")) {
    return <ImageIcon size={14} weight="duotone" className="shrink-0 text-accent-soft" />;
  }
  if (contentType?.startsWith("text/") || path.toLowerCase().endsWith(".md")) {
    return <FileText size={14} weight="duotone" className="shrink-0 text-accent-soft" />;
  }
  return <File size={14} weight="duotone" className="shrink-0 text-muted" />;
}

export default function TabBar({ contentTypeFor, onCloseTab }: TabBarProps) {
  const { state, dispatch } = useWorkspace();
  const stripRef = useRef<HTMLDivElement>(null);

  if (state.tabs.length === 0) return null;

  function onTabKeyDown(e: React.KeyboardEvent, tab: Tab, index: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = state.tabs[index + dir];
      if (next) dispatch({ type: "ACTIVATE_TAB", id: next.id });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dispatch({ type: "ACTIVATE_TAB", id: tab.id });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onCloseTab(tab.id);
    }
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open files"
      className="custom-scroll flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-secondary"
    >
      {state.tabs.map((tab, index) => {
        const active = tab.id === state.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={tab.path}
            onClick={() => dispatch({ type: "ACTIVATE_TAB", id: tab.id })}
            onKeyDown={(e) => onTabKeyDown(e, tab, index)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onCloseTab(tab.id);
              }
            }}
            className={[
              "group relative flex min-w-[120px] max-w-[200px] cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[13px] outline-none transition-colors",
              active
                ? "bg-canvas text-ink"
                : "bg-secondary text-muted hover:bg-hover hover:text-ink",
            ].join(" ")}
          >
            {active && (
              <span className="absolute left-0 top-0 h-0.5 w-full bg-accent" aria-hidden />
            )}
            <TabIcon path={tab.path} contentType={contentTypeFor(tab.path)} />
            <span className="flex-1 truncate">{basename(tab.path)}</span>
            {tab.dirty ? (
              <span
                className="flex h-4 w-4 items-center justify-center"
                aria-label="Unsaved changes"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent-soft group-hover:hidden" />
                <X
                  size={12}
                  weight="bold"
                  className="hidden text-muted hover:text-ink group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                />
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Close ${basename(tab.path)}`}
                className="flex h-4 w-4 items-center justify-center rounded text-muted opacity-0 hover:bg-elevated hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
