import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TabMode = "live" | "preview";

export interface Tab {
  /** Stable identifier for this tab instance. */
  id: string;
  /** Vault content path this tab is showing. */
  path: string;
  /** Editor display mode for markdown notes. */
  mode: TabMode;
  /** True when editBuffer differs from baseContent (unsaved). */
  dirty: boolean;
  /** Current in-memory edited content (undefined until loaded/edited). */
  editBuffer?: string;
  /** Content as last loaded or saved — the conflict base. */
  baseContent?: string;
  /** Revision as last loaded or saved — the conflict base. */
  baseRevision?: number;
}

export interface PanelState {
  collapsed: boolean;
  width: number;
}

export type RightPanelTab = "backlinks" | "outline";

export interface RightPanelState extends PanelState {
  tab: RightPanelTab;
}

export interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  left: PanelState;
  right: RightPanelState;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const LEFT_DEFAULT_WIDTH = 264;
export const RIGHT_DEFAULT_WIDTH = 288;
export const LEFT_MIN_WIDTH = 180;
export const LEFT_MAX_WIDTH = 480;
export const RIGHT_MIN_WIDTH = 200;
export const RIGHT_MAX_WIDTH = 480;

function clampWidth(w: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(w)));
}

function initialState(): WorkspaceState {
  return {
    tabs: [],
    activeTabId: null,
    left: { collapsed: false, width: LEFT_DEFAULT_WIDTH },
    right: { collapsed: false, width: RIGHT_DEFAULT_WIDTH, tab: "backlinks" },
  };
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type WorkspaceAction =
  | { type: "HYDRATE"; state: WorkspaceState }
  | { type: "OPEN_FILE"; path: string; mode?: TabMode; activate?: boolean }
  | { type: "ACTIVATE_TAB"; id: string }
  | { type: "CLOSE_TAB"; id: string }
  | { type: "CLOSE_OTHER_TABS"; id: string }
  | { type: "SET_TAB_MODE"; id: string; mode: TabMode }
  | {
      type: "SET_TAB_CONTENT";
      id: string;
      editBuffer: string;
      baseContent: string;
      baseRevision: number;
    }
  | { type: "EDIT_TAB_BUFFER"; id: string; editBuffer: string }
  | {
      type: "MARK_TAB_SAVED";
      id: string;
      content: string;
      revision: number;
    }
  | { type: "RENAME_PATH"; oldPath: string; newPath: string }
  | { type: "REMOVE_PATH"; path: string }
  | { type: "TOGGLE_LEFT"; collapsed?: boolean }
  | { type: "SET_LEFT_WIDTH"; width: number }
  | { type: "TOGGLE_RIGHT"; collapsed?: boolean }
  | { type: "SET_RIGHT_WIDTH"; width: number }
  | { type: "SET_RIGHT_TAB"; tab: RightPanelTab };

function neighborTabId(tabs: Tab[], closingId: string): string | null {
  const idx = tabs.findIndex((t) => t.id === closingId);
  if (idx === -1) return null;
  const next = tabs[idx + 1] ?? tabs[idx - 1];
  return next ? next.id : null;
}

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "HYDRATE":
      return action.state;

    case "OPEN_FILE": {
      const existing = state.tabs.find((t) => t.path === action.path);
      if (existing) {
        return {
          ...state,
          activeTabId: action.activate === false ? state.activeTabId : existing.id,
          tabs: action.mode
            ? state.tabs.map((t) =>
                t.id === existing.id ? { ...t, mode: action.mode! } : t
              )
            : state.tabs,
        };
      }
      const tab: Tab = {
        id: newTabId(),
        path: action.path,
        mode: action.mode ?? "preview",
        dirty: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTabId: action.activate === false ? state.activeTabId : tab.id,
      };
    }

    case "ACTIVATE_TAB":
      return { ...state, activeTabId: action.id };

    case "CLOSE_TAB": {
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.id) {
        activeTabId = neighborTabId(state.tabs, action.id);
      }
      return { ...state, tabs, activeTabId };
    }

    case "CLOSE_OTHER_TABS": {
      const keep = state.tabs.find((t) => t.id === action.id);
      if (!keep) return state;
      return { ...state, tabs: [keep], activeTabId: keep.id };
    }

    case "SET_TAB_MODE":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, mode: action.mode } : t
        ),
      };

    case "SET_TAB_CONTENT":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id
            ? {
                ...t,
                editBuffer: action.editBuffer,
                baseContent: action.baseContent,
                baseRevision: action.baseRevision,
                dirty: false,
              }
            : t
        ),
      };

    case "EDIT_TAB_BUFFER":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id
            ? {
                ...t,
                editBuffer: action.editBuffer,
                dirty: action.editBuffer !== (t.baseContent ?? ""),
              }
            : t
        ),
      };

    case "MARK_TAB_SAVED":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id
            ? {
                ...t,
                editBuffer: action.content,
                baseContent: action.content,
                baseRevision: action.revision,
                dirty: false,
              }
            : t
        ),
      };

    case "RENAME_PATH":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.oldPath ? { ...t, path: action.newPath } : t
        ),
      };

    case "REMOVE_PATH": {
      const closing = state.tabs.find((t) => t.path === action.path);
      const tabs = state.tabs.filter((t) => t.path !== action.path);
      let activeTabId = state.activeTabId;
      if (closing && state.activeTabId === closing.id) {
        activeTabId = neighborTabId(state.tabs, closing.id);
      }
      return { ...state, tabs, activeTabId };
    }

    case "TOGGLE_LEFT":
      return {
        ...state,
        left: {
          ...state.left,
          collapsed: action.collapsed ?? !state.left.collapsed,
        },
      };

    case "SET_LEFT_WIDTH":
      return {
        ...state,
        left: {
          ...state.left,
          width: clampWidth(action.width, LEFT_MIN_WIDTH, LEFT_MAX_WIDTH),
        },
      };

    case "TOGGLE_RIGHT":
      return {
        ...state,
        right: {
          ...state.right,
          collapsed: action.collapsed ?? !state.right.collapsed,
        },
      };

    case "SET_RIGHT_WIDTH":
      return {
        ...state,
        right: {
          ...state.right,
          width: clampWidth(action.width, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH),
        },
      };

    case "SET_RIGHT_TAB":
      return { ...state, right: { ...state.right, tab: action.tab } };

    default:
      return state;
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────--

interface PersistedState {
  tabs: Array<Pick<Tab, "path" | "mode">>;
  activePath: string | null;
  left: PanelState;
  right: RightPanelState;
}

function storageKey(vaultId: string): string {
  return `lapis-workspace-${vaultId}`;
}

function loadPersisted(vaultId: string): WorkspaceState {
  const base = initialState();
  try {
    const raw = localStorage.getItem(storageKey(vaultId));
    if (!raw) return base;
    const parsed = JSON.parse(raw) as PersistedState;
    const tabs: Tab[] = (parsed.tabs ?? []).map((t) => ({
      id: newTabId(),
      path: t.path,
      mode: t.mode === "preview" ? "preview" : "live",
      dirty: false,
    }));
    const active =
      tabs.find((t) => t.path === parsed.activePath)?.id ??
      (tabs.length > 0 ? tabs[tabs.length - 1].id : null);
    return {
      tabs,
      activeTabId: active,
      left: parsed.left
        ? {
            collapsed: !!parsed.left.collapsed,
            width: clampWidth(parsed.left.width, LEFT_MIN_WIDTH, LEFT_MAX_WIDTH),
          }
        : base.left,
      right: parsed.right
        ? {
            collapsed: !!parsed.right.collapsed,
            width: clampWidth(
              parsed.right.width,
              RIGHT_MIN_WIDTH,
              RIGHT_MAX_WIDTH
            ),
            tab: parsed.right.tab === "outline" ? "outline" : "backlinks",
          }
        : base.right,
    };
  } catch {
    return base;
  }
}

function persist(vaultId: string, state: WorkspaceState): void {
  try {
    const activePath =
      state.tabs.find((t) => t.id === state.activeTabId)?.path ?? null;
    const data: PersistedState = {
      tabs: state.tabs.map((t) => ({ path: t.path, mode: t.mode })),
      activePath,
      left: state.left,
      right: state.right,
    };
    localStorage.setItem(storageKey(vaultId), JSON.stringify(data));
  } catch {
    // ignore quota / serialization errors
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

interface WorkspaceContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  activeTab: Tab | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  vaultId,
  children,
}: {
  vaultId: string;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    reducer,
    vaultId,
    loadPersisted
  );

  // Re-hydrate when the vault changes.
  const lastVault = useRef(vaultId);
  useEffect(() => {
    if (lastVault.current !== vaultId) {
      lastVault.current = vaultId;
      dispatch({ type: "HYDRATE", state: loadPersisted(vaultId) });
    }
  }, [vaultId]);

  // Persist on any change (debounced via microtask coalescing is unnecessary here).
  useEffect(() => {
    persist(vaultId, state);
  }, [vaultId, state]);

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? null,
    [state.tabs, state.activeTabId]
  );

  const value = useMemo(
    () => ({ state, dispatch, activeTab }),
    [state, activeTab]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return ctx;
}
