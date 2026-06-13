import type { ReactNode } from "react";
import { useWorkspace, LEFT_DEFAULT_WIDTH, RIGHT_DEFAULT_WIDTH, LEFT_MIN_WIDTH, LEFT_MAX_WIDTH, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH } from "../../store/workspace";
import ResizeHandle from "./ResizeHandle";

interface WorkspaceLayoutProps {
  /** 40px top chrome: window controls, breadcrumb, panel toggles, search, theme. */
  titleBar?: ReactNode;
  /** Tab strip beneath the title bar. */
  tabBar?: ReactNode;
  /** 24px bottom chrome: presence, counts, sync state. */
  statusBar?: ReactNode;
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
  left,
  children,
  right,
}: WorkspaceLayoutProps) {
  const { state, dispatch } = useWorkspace();
  const leftOpen = !state.left.collapsed;
  const rightOpen = !state.right.collapsed;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      {titleBar}
      <div className="flex min-h-0 flex-1">
        {/* Left sidebar */}
        {leftOpen && (
          <aside
            className="flex min-h-0 shrink-0 flex-col border-r border-border bg-secondary"
            style={{ width: state.left.width }}
            aria-label="Sidebar"
          >
            {left}
          </aside>
        )}
        {leftOpen && (
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

        {/* Center column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tabBar}
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>

        {/* Right panel */}
        {rightOpen && (
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
        {rightOpen && (
          <aside
            className="flex min-h-0 shrink-0 flex-col border-l border-border bg-secondary"
            style={{ width: state.right.width }}
            aria-label="Right panel"
          >
            {right}
          </aside>
        )}
      </div>
      {statusBar}
    </div>
  );
}
