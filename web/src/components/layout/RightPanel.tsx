/**
 * RightPanel — tabbed context panel (Backlinks / Outline) for the active note.
 * The selected tab is persisted via the workspace store.
 */

import { LinkSimple, ListBullets } from "@phosphor-icons/react";
import { useWorkspace, type RightPanelTab } from "../../store/workspace";
import BacklinksPanel from "../BacklinksPanel";
import OutlinePanel from "../OutlinePanel";

interface Props {
  vaultId: string;
  activePath: string | null;
  activeSource: string | null;
  onNavigate: (path: string) => void;
}

const TABS: { id: RightPanelTab; label: string; icon: typeof LinkSimple }[] = [
  { id: "backlinks", label: "Backlinks", icon: LinkSimple },
  { id: "outline", label: "Outline", icon: ListBullets },
];

export default function RightPanel({ vaultId, activePath, activeSource, onNavigate }: Props) {
  const { state, dispatch } = useWorkspace();
  const active = state.right.tab;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Context panel" className="flex h-9 shrink-0 items-center border-b border-border px-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => dispatch({ type: "SET_RIGHT_TAB", tab: tab.id })}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const idx = TABS.findIndex((t) => t.id === active);
                  const nextIdx =
                    e.key === "ArrowRight"
                      ? (idx + 1) % TABS.length
                      : (idx - 1 + TABS.length) % TABS.length;
                  dispatch({ type: "SET_RIGHT_TAB", tab: TABS[nextIdx].id });
                }
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm py-1 text-[12px] font-medium transition-colors ${
                selected ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              <Icon size={14} weight={selected ? "fill" : "regular"} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {active === "backlinks" ? (
          activePath ? (
            <BacklinksPanel vaultId={vaultId} path={activePath} onNavigate={onNavigate} />
          ) : (
            <p className="px-1 py-2 text-[13px] text-muted">Open a note to see backlinks.</p>
          )
        ) : (
          <OutlinePanel source={activeSource} />
        )}
      </div>
    </div>
  );
}
