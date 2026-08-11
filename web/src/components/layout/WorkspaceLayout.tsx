import type { ReactNode } from "react";
import {
  useWorkspace,
  LEFT_DEFAULT_WIDTH,
  RIGHT_DEFAULT_WIDTH,
  LEFT_MIN_WIDTH,
  LEFT_MAX_WIDTH,
  RIGHT_MIN_WIDTH,
  RIGHT_MAX_WIDTH,
} from "../../store/workspace";
import ResizeHandle from "./ResizeHandle";
import { useIsMobile } from "../../hooks/useMobile";

interface WorkspaceLayoutProps {
  /** 40px top chrome: window controls, breadcrumb, panel toggles, search, theme. */
  titleBar?: ReactNode;
  /** Tab strip beneath the title bar — hidden on mobile. */
  tabBar?: ReactNode;
  /** 24px bottom chrome: presence, counts, sync state — hidden on mobile. */
  statusBar?: ReactNode;
  /** Bottom toolbar rendered only on mobile. */
  mobileBar?: ReactNode;
  /** Left sidebar contents (file tree, search, snapshots). */
  left: ReactNode;
  /** Center editor / viewer region. */
  children: ReactNode;
  /** Right panel contents (backlinks, outline). */
  right: ReactNode;
}

export default function WorkspaceLayout({
  titleBar,
  tabBar,
  statusBar,
  mobileBar,
  left,
  children,
  right,
}: WorkspaceLayoutProps) {
  const { state, dispatch } = useWorkspace();
  const isMobile = useIsMobile();
  const leftOpen = !state.left.collapsed;
  const rightOpen = !state.right.collapsed;

  const closeLeft = () => dispatch({ type: "TOGGLE_LEFT", collapsed: true });
  const closeRight = () => dispatch({ type: "TOGGLE_RIGHT", collapsed: true });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      {titleBar}

      <div className="flex min-h-0 flex-1">
        {/* ── Desktop: left sidebar inline ── */}
        {!isMobile && leftOpen && (
          <aside
            className="flex min-h-0 shrink-0 flex-col border-r border-border bg-secondary"
            style={{ width: state.left.width }}
            aria-label="Sidebar"
          >
            {left}
          </aside>
        )}
        {!isMobile && leftOpen && (
          <ResizeHandle
            side="left"
            width={state.left.width}
            onResize={(w) => dispatch({ type: "SET_LEFT_WIDTH", width: w })}
            onReset={() =>
              dispatch({ type: "SET_LEFT_WIDTH", width: LEFT_DEFAULT_WIDTH })
            }
            min={LEFT_MIN_WIDTH}
            max={LEFT_MAX_WIDTH}
            ariaLabel="Resize sidebar"
          />
        )}

        {/* ── Center column ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!isMobile && tabBar}
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>

        {/* ── Desktop: right panel inline ── */}
        {!isMobile && rightOpen && (
          <ResizeHandle
            side="right"
            width={state.right.width}
            onResize={(w) => dispatch({ type: "SET_RIGHT_WIDTH", width: w })}
            onReset={() =>
              dispatch({ type: "SET_RIGHT_WIDTH", width: RIGHT_DEFAULT_WIDTH })
            }
            min={RIGHT_MIN_WIDTH}
            max={RIGHT_MAX_WIDTH}
            ariaLabel="Resize right panel"
          />
        )}
        {!isMobile && rightOpen && (
          <aside
            className="flex min-h-0 shrink-0 flex-col border-l border-border bg-secondary"
            style={{ width: state.right.width }}
            aria-label="Right panel"
          >
            {right}
          </aside>
        )}
      </div>

      {/* ── Bottom bars ── */}
      {isMobile ? mobileBar : statusBar}

      {/* ── Mobile overlay drawers ── */}
      {isMobile && (leftOpen || rightOpen) && (
        <div
          className="fixed inset-0 z-30 bg-scrim"
          aria-hidden
          onClick={() => {
            closeLeft();
            closeRight();
          }}
        />
      )}

      {isMobile && leftOpen && (
        <aside
          className="fixed inset-y-0 left-0 z-40 flex w-4/5 max-w-xs flex-col border-r border-border bg-secondary"
          aria-label="Sidebar"
        >
          {left}
        </aside>
      )}

      {isMobile && rightOpen && (
        <aside
          className="fixed inset-y-0 right-0 z-40 flex w-4/5 max-w-xs flex-col border-l border-border bg-secondary"
          aria-label="Right panel"
        >
          {right}
        </aside>
      )}
    </div>
  );
}
