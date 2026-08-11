import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api";
import { FolderTree, buildTree, joinPath, parentDir } from "../components/FolderTree";
import MarkdownView from "../components/MarkdownView";
import SearchPanel from "../components/SearchPanel";
import SnapshotsPanel from "../components/SnapshotsPanel";
import RightPanel from "../components/layout/RightPanel";
import MarkdownEditor from "../components/editor/MarkdownEditor";
import { useTheme } from "../hooks/useTheme";
import { useVaultNotify } from "../hooks/useVaultNotify";
import { useVaultYjs } from "../hooks/useVaultYjs";
import { useIsMobile } from "../hooks/useMobile";
import {
  WorkspaceProvider,
  useWorkspace,
  type Tab,
} from "../store/workspace";
import WorkspaceLayout from "../components/layout/WorkspaceLayout";
import TitleBar from "../components/layout/TitleBar";
import TabBar from "../components/layout/TabBar";
import StatusBar, { type SyncState } from "../components/layout/StatusBar";
import MobileToolbar from "../components/layout/MobileToolbar";
import {
  FilePlus,
  FolderPlus,
  UploadSimple,
  PencilSimple,
  Eye,
  Trash,
  TextAlignLeft,
  DownloadSimple,
  FloppyDisk,
  ArrowCounterClockwise,
  X as XIcon,
  FileMagnifyingGlass,
  MagnifyingGlass,
  SidebarSimple,
  SidebarSimple as SidebarRightIcon,
  Sun,
  Moon,
  DeviceMobile,
  House,
} from "@phosphor-icons/react";
import { useToast } from "../components/ui/Toast";
import CommandPalette, {
  type Command,
  type PaletteMode,
} from "../components/overlays/CommandPalette";

// ── Helpers (ported from VaultBrowserPage) ──────────────────────────────────--

const TEXT_TYPES = ["text/", "application/json", "application/xml"];
const IMAGE_TYPES = ["image/"];
const isTextType = (ct: string) => TEXT_TYPES.some((t) => ct.startsWith(t));
const isImageType = (ct: string) => IMAGE_TYPES.some((t) => ct.startsWith(t));
const isMarkdown = (ct: string, path: string) =>
  ct === "text/markdown" || path.toLowerCase().endsWith(".md");

function encodeVaultRoutePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
function decodeVaultRoutePath(path: string): string {
  return path
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Adapt Yjs-derived entries to ManifestEntry (r2Key unused in UI). */
function asManifestEntries(
  entries: Array<{
    path: string;
    size: number;
    contentType: string;
    updatedAt: string;
    revision: number;
  }>
): api.ManifestEntry[] {
  return entries.map((e) => ({ ...e, r2Key: "" }));
}

type Modal =
  | { kind: "none" }
  | { kind: "newNote"; value: string; parent: string; error: string | null }
  | { kind: "newFolder"; value: string; parent: string; error: string | null }
  | { kind: "rename"; path: string; value: string; error: string | null }
  | { kind: "deleteConfirm"; path: string }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    };

// ── Entry point ─────────────────────────────────────────────────────────────--

export default function VaultWorkspace() {
  const { id: vaultId } = useParams<{ id: string }>();
  if (!vaultId) return null;
  return (
    <WorkspaceProvider vaultId={vaultId}>
      <WorkspaceInner vaultId={vaultId} />
    </WorkspaceProvider>
  );
}

// ── Inner (inside provider) ─────────────────────────────────────────────────--

function WorkspaceInner({ vaultId }: { vaultId: string }) {
  const { "*": routeSplat } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const { state, dispatch, activeTab } = useWorkspace();
  const { theme, toggleTheme } = useTheme();
  const { toast } = useToast();
  const isMobile = useIsMobile();

  const [vault, setVault] = useState<api.Vault | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  /** Folder path used as the create target ("" = vault root). */
  const [createParent, setCreateParent] = useState("");
  const [load, setLoad] = useState<{
    tabId: string;
    status: "loading" | "error";
    message?: string;
  } | null>(null);
  const [dismissedWarning, setDismissedWarning] = useState(false);

  const uploadRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialRouteHandled = useRef(false);
  const mobileRightCollapsed = useRef(false);
  const activeTabRef = useRef<Tab | null>(activeTab);
  const tabsRef = useRef(state.tabs);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    tabsRef.current = state.tabs;
  }, [state.tabs]);

  // Right panel closed by default on mobile (takes too much space).
  useEffect(() => {
    if (isMobile && !mobileRightCollapsed.current) {
      mobileRightCollapsed.current = true;
      if (!state.right.collapsed) {
        dispatch({ type: "TOGGLE_RIGHT", collapsed: true });
      }
    }
  }, [isMobile, state.right.collapsed, dispatch]);

  const {
    manifestEntries,
    ready: yjsReady,
    connected: yjsConnected,
    readText,
    saveText,
    createNote,
    rename: yjsRename,
    remove: yjsRemove,
  } = useVaultYjs(vaultId);

  const manifest = useMemo((): api.VaultManifest | null => {
    if (!yjsReady) return null;
    const entries: Record<string, api.ManifestEntry> = {};
    for (const e of asManifestEntries(manifestEntries)) {
      entries[e.path.toLowerCase()] = e;
    }
    return {
      vaultId,
      updatedAt: new Date().toISOString(),
      entries,
    };
  }, [vaultId, yjsReady, manifestEntries]);

  useEffect(() => {
    api.getVault(vaultId).then(setVault).catch(() => {});
  }, [vaultId]);

  // ── Open a file in a tab ────────────────────────────────────────────────--

  // Drop persisted tabs whose files no longer exist once the manifest arrives.
  useEffect(() => {
    if (!manifest) return;
    dispatch({
      type: "PRUNE_TABS",
      validPathsLower: Object.keys(manifest.entries),
    });
  }, [manifest, dispatch]);

  const openFile = useCallback(
    (path: string) => {
      setCreateParent(parentDir(path));
      dispatch({ type: "OPEN_FILE", path });
      if (isMobile && !state.left.collapsed) {
        dispatch({ type: "TOGGLE_LEFT", collapsed: true });
      }
    },
    [dispatch, isMobile, state.left.collapsed]
  );

  const openNewNoteModal = useCallback(
    (parent?: string) => {
      const dir = parent ?? createParent;
      setModal({ kind: "newNote", value: "", parent: dir, error: null });
    },
    [createParent]
  );

  const openNewFolderModal = useCallback(
    (parent?: string) => {
      const dir = parent ?? createParent;
      setModal({ kind: "newFolder", value: "", parent: dir, error: null });
    },
    [createParent]
  );

  // Handle initial deep link (/vault/:id/file/...) once manifest is loaded.
  useEffect(() => {
    if (!manifest || initialRouteHandled.current) return;
    initialRouteHandled.current = true;
    if (routeSplat && routeSplat.startsWith("file/")) {
      const path = decodeVaultRoutePath(routeSplat.slice("file/".length));
      if (manifest.entries[path.toLowerCase()]) {
        dispatch({ type: "OPEN_FILE", path });
      }
    }
  }, [manifest, routeSplat, dispatch]);

  // Sync active tab path -> URL.
  useEffect(() => {
    const urlPath =
      routeSplat && routeSplat.startsWith("file/")
        ? decodeVaultRoutePath(routeSplat.slice("file/".length))
        : null;
    if (activeTab) {
      if (activeTab.path !== urlPath) {
        navigate(`/vault/${vaultId}/file/${encodeVaultRoutePath(activeTab.path)}`);
      }
    } else if (urlPath) {
      navigate(`/vault/${vaultId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.path]);

  // ── Load content for active text tab ───────────────────────────────────--

  useEffect(() => {
    if (!activeTab || !manifest || !yjsReady) return;
    const entry = manifest.entries[activeTab.path.toLowerCase()];
    if (!entry) {
      setLoad({ tabId: activeTab.id, status: "error", message: "File not in manifest" });
      return;
    }
    if (!isTextType(entry.contentType)) {
      setLoad(null);
      return;
    }
    if (activeTab.baseContent !== undefined) {
      setLoad(null);
      return;
    }
    const content = readText(activeTab.path);
    if (content === null) {
      setLoad({ tabId: activeTab.id, status: "error", message: "File not in vault" });
      return;
    }
    dispatch({
      type: "SET_TAB_CONTENT",
      id: activeTab.id,
      editBuffer: content,
      baseContent: content,
    });
    setLoad(null);
  }, [
    activeTab?.id,
    activeTab?.path,
    activeTab?.baseContent,
    manifest,
    yjsReady,
    readText,
    dispatch,
  ]);

  // Sync remote Yjs text into open non-dirty tabs.
  useEffect(() => {
    if (!yjsReady || !manifest) return;
    for (const tab of tabsRef.current) {
      if (tab.dirty || tab.baseContent === undefined) continue;
      const entry = manifest.entries[tab.path.toLowerCase()];
      if (!entry || !isTextType(entry.contentType)) continue;
      const remote = readText(tab.path);
      if (remote === null || remote === tab.baseContent) continue;
      dispatch({
        type: "SET_TAB_CONTENT",
        id: tab.id,
        editBuffer: remote,
        baseContent: remote,
      });
    }
  }, [manifestEntries, yjsReady, manifest, readText, dispatch]);

  // ── Unsaved-edit guards ─────────────────────────────────────────────────--

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!tabsRef.current.some((t) => t.dirty)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const navigateGuard = useCallback((): boolean => {
    if (!tabsRef.current.some((t) => t.dirty)) return true;
    return window.confirm("You have unsaved edits. Leave and discard them?");
  }, []);

  // ── Close a tab (guarding dirty) ───────────────────────────────────────--

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.dirty) {
        setModal({
          kind: "confirm",
          title: "Discard unsaved changes?",
          message: `${tab.path} has unsaved edits that will be lost.`,
          confirmLabel: "Discard",
          danger: true,
          onConfirm: () => dispatch({ type: "CLOSE_TAB", id }),
        });
        return;
      }
      dispatch({ type: "CLOSE_TAB", id });
    },
    [dispatch]
  );

  // ── Save the active editing tab ────────────────────────────────────────--

  const [saving, setSaving] = useState(false);

  const saveTab = useCallback(
    async (tab: Tab) => {
      if (tab.editBuffer === undefined) return;
      setSaving(true);
      try {
        saveText(tab.path, tab.editBuffer);
        dispatch({
          type: "MARK_TAB_SAVED",
          id: tab.id,
          content: tab.editBuffer,
        });
        toast("Saved", { tone: "success", duration: 1500 });
      } catch (e) {
        toast((e as Error).message, { tone: "error" });
      } finally {
        setSaving(false);
      }
    },
    [saveText, dispatch, toast]
  );

  // ── Revert the active tab to the server version ──────────────────────────--

  const doRevert = useCallback(
    (tab: Tab) => {
      try {
        const content = readText(tab.path);
        if (content === null) throw new Error("File not in vault");
        dispatch({
          type: "SET_TAB_CONTENT",
          id: tab.id,
          editBuffer: content,
          baseContent: content,
        });
        toast("Reverted to vault version", { tone: "success", duration: 1500 });
      } catch (e) {
        toast((e as Error).message, { tone: "error" });
      }
    },
    [readText, dispatch, toast]
  );

  const revertTab = useCallback(
    (tab: Tab) => {
      setModal({
        kind: "confirm",
        title: "Revert to vault version?",
        message: `Discard your local changes to ${tab.path} and reload the version in the vault?`,
        confirmLabel: "Revert",
        danger: true,
        onConfirm: () => doRevert(tab),
      });
    },
    [doRevert]
  );

  const { presence, sameFileWarning } = useVaultNotify(vaultId, activeTab?.path ?? null);

  useEffect(() => {
    if (sameFileWarning) setDismissedWarning(false);
  }, [sameFileWarning?.path]);

  // ── Create / upload / rename / delete ──────────────────────────────────--

  async function handleCreateNote() {
    if (modal.kind !== "newNote") return;
    let name = modal.value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!name) return;
    // Strip trailing .md from input — ghost suffix implies it.
    if (name.toLowerCase().endsWith(".md")) name = name.slice(0, -3);
    if (!name || name.includes("..")) {
      setModal({ ...modal, error: "Invalid note name" });
      return;
    }
    const path = joinPath(modal.parent, `${name}.md`);
    try {
      createNote(path, "");
      setModal({ kind: "none" });
      dispatch({ type: "OPEN_FILE", path });
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
    }
  }

  async function handleCreateFolder() {
    if (modal.kind !== "newFolder") return;
    let name = modal.value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!name || name.includes("..") || name.includes("/")) {
      setModal({ ...modal, error: "Invalid folder name" });
      return;
    }
    const folderPath = joinPath(modal.parent, name);
    const keepPath = joinPath(folderPath, ".keep");
    try {
      createNote(keepPath, "");
      setCreateParent(folderPath);
      setModal({ kind: "none" });
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
    }
  }

  async function handleMove(sourcePath: string, destFolder: string) {
    const name = sourcePath.split("/").pop()!;
    const newPath = joinPath(destFolder, name);
    if (newPath === sourcePath) return;
    try {
      yjsRename(sourcePath, newPath);
      dispatch({ type: "RENAME_PATH", oldPath: sourcePath, newPath });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files) return;
    let uploaded = 0;
    for (const file of Array.from(files)) {
      try {
        await api.uploadFile(vaultId, file.name, file);
        uploaded++;
      } catch (e) {
        toast(`Upload failed for ${file.name}: ${(e as Error).message}`, {
          tone: "error",
        });
      }
    }
    if (uploaded > 0)
      toast(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`, {
        tone: "success",
      });
  }

  async function handleRename() {
    if (modal.kind !== "rename") return;
    const newPath = modal.value.trim();
    if (!newPath || newPath === modal.path) {
      setModal({ kind: "none" });
      return;
    }
    try {
      yjsRename(modal.path, newPath);
      dispatch({ type: "RENAME_PATH", oldPath: modal.path, newPath });
      setModal({ kind: "none" });
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
    }
  }

  async function handleDelete() {
    if (modal.kind !== "deleteConfirm") return;
    const { path } = modal;
    try {
      yjsRemove(path);
      dispatch({ type: "REMOVE_PATH", path });
      setModal({ kind: "none" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
      setModal({ kind: "none" });
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────--

  const treeNodes = useMemo(
    () => (manifest ? buildTree(Object.values(manifest.entries)) : []),
    [manifest]
  );
  const vaultPaths = useMemo(
    () => (manifest ? Object.values(manifest.entries).map((e) => e.path) : []),
    [manifest]
  );
  const contentTypeFor = (path: string) =>
    manifest?.entries[path.toLowerCase()]?.contentType;

  const activeText =
    activeTab && activeTab.editBuffer !== undefined ? activeTab.editBuffer : null;
  const syncState: SyncState =
    !yjsReady || !yjsConnected
      ? "idle"
      : saving
        ? "saving"
        : activeTab?.dirty
          ? "dirty"
          : "idle";

  const activeIsMd = activeTab
    ? isMarkdown(
        manifest?.entries[activeTab.path.toLowerCase()]?.contentType ?? "",
        activeTab.path
      )
    : false;

  const toggleActiveMode = useCallback(() => {
    if (!activeTab) return;
    dispatch({
      type: "SET_TAB_MODE",
      id: activeTab.id,
      mode: activeTab.mode === "preview" ? "live" : "preview",
    });
  }, [activeTab, dispatch]);

  const openSearch = useCallback(() => {
    if (state.left.collapsed) dispatch({ type: "TOGGLE_LEFT", collapsed: false });
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [state.left.collapsed, dispatch]);

  const guardedNavigate = useCallback(
    (to: string) => {
      if (navigateGuard()) navigate(to);
    },
    [navigateGuard, navigate]
  );

  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const tabs = tabsRef.current;
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeTabRef.current?.id);
      const next = (idx + dir + tabs.length) % tabs.length;
      dispatch({ type: "ACTIVATE_TAB", id: tabs[next].id });
    },
    [dispatch]
  );

  // ── Command palette actions ────────────────────────────────────────────--

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      {
        id: "new-note",
        title: "New note",
        hint: "⌘N",
        keywords: "create file add",
        icon: <FilePlus size={16} />,
        run: () => openNewNoteModal(),
      },
      {
        id: "quick-open",
        title: "Go to file…",
        hint: "⌘O",
        keywords: "open switch quick find",
        icon: <FileMagnifyingGlass size={16} />,
        run: () => setPalette("files"),
      },
      {
        id: "upload",
        title: "Upload file…",
        keywords: "attach import",
        icon: <UploadSimple size={16} />,
        run: () => uploadRef.current?.click(),
      },
      {
        id: "search",
        title: "Search vault",
        hint: "⌘F",
        keywords: "find text grep",
        icon: <MagnifyingGlass size={16} />,
        run: () => openSearch(),
      },
      {
        id: "toggle-left",
        title: state.left.collapsed
          ? "Show file sidebar"
          : "Hide file sidebar",
        hint: "⌘B",
        keywords: "panel explorer tree",
        icon: <SidebarSimple size={16} />,
        run: () => dispatch({ type: "TOGGLE_LEFT" }),
      },
      {
        id: "toggle-right",
        title: state.right.collapsed
          ? "Show right panel"
          : "Hide right panel",
        hint: "⌘\\",
        keywords: "backlinks outline panel",
        icon: <SidebarRightIcon size={16} className="scale-x-[-1]" />,
        run: () => dispatch({ type: "TOGGLE_RIGHT" }),
      },
      {
        id: "toggle-theme",
        title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        keywords: "dark mode appearance color",
        icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        run: () => toggleTheme(),
      },
      {
        id: "export",
        title: "Export vault",
        keywords: "download backup zip",
        icon: <DownloadSimple size={16} />,
        run: () => window.open(api.exportUrl(vaultId), "_blank"),
      },
      {
        id: "devices",
        title: "Manage devices",
        keywords: "sync plugin connect",
        icon: <DeviceMobile size={16} />,
        run: () => guardedNavigate(`/vault/${vaultId}/devices`),
      },
      {
        id: "home",
        title: "Back to vaults",
        keywords: "list home exit",
        icon: <House size={16} />,
        run: () => guardedNavigate("/"),
      },
    ];

    if (activeTab) {
      const tab = activeTab;
      const isMd = isMarkdown(
        manifest?.entries[tab.path.toLowerCase()]?.contentType ?? "",
        tab.path
      );
      if (isMd) {
        list.push({
          id: "toggle-mode",
          title: tab.mode === "preview" ? "Edit mode" : "Preview mode",
          keywords: "render source live",
          icon: tab.mode === "preview" ? <PencilSimple size={16} /> : <Eye size={16} />,
          run: () =>
            dispatch({
              type: "SET_TAB_MODE",
              id: tab.id,
              mode: tab.mode === "preview" ? "live" : "preview",
            }),
        });
      }
      if (tab.dirty) {
        list.push({
          id: "save",
          title: "Save file",
          hint: "⌘S",
          keywords: "write persist",
          icon: <FloppyDisk size={16} />,
          run: () => void saveTab(tab),
        });
      }
      list.push(
        {
          id: "close-tab",
          title: "Close tab",
          hint: "⌘W",
          keywords: "dismiss",
          icon: <XIcon size={16} />,
          run: () => closeTab(tab.id),
        },
        {
          id: "rename",
          title: "Rename / move file",
          hint: "F2",
          keywords: "move path",
          icon: <PencilSimple size={16} />,
          run: () =>
            setModal({ kind: "rename", path: tab.path, value: tab.path, error: null }),
        },
        {
          id: "delete",
          title: "Delete file",
          keywords: "remove trash",
          icon: <Trash size={16} />,
          run: () => setModal({ kind: "deleteConfirm", path: tab.path }),
        }
      );
    }
    return list;
  }, [
    activeTab,
    manifest,
    state.left.collapsed,
    state.right.collapsed,
    theme,
    vaultId,
    dispatch,
    toggleTheme,
    openSearch,
    saveTab,
    closeTab,
    guardedNavigate,
  ]);

  // ── Global hotkeys ─────────────────────────────────────────────────────--

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Tab cycling works regardless of overlays being open.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Suppress other shortcuts while an overlay owns the keyboard.
      if (palette || modal.kind !== "none") return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "p" && !e.shiftKey) {
        e.preventDefault();
        setPalette("commands");
      } else if (k === "o") {
        e.preventDefault();
        setPalette("files");
      } else if (k === "f") {
        e.preventDefault();
        openSearch();
      } else if (k === "b") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_LEFT" });
      } else if (k === "\\") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_RIGHT" });
      } else if (k === "n") {
        e.preventDefault();
        openNewNoteModal();
      } else if (k === "w") {
        if (activeTabRef.current) {
          e.preventDefault();
          closeTab(activeTabRef.current.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, modal.kind, cycleTab, openSearch, dispatch, closeTab]);

  // ── Render ─────────────────────────────────────────────────────────────--

  return (
    <>
      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleUpload(e.target.files)}
      />
      <WorkspaceLayout
        titleBar={
          <TitleBar
            vaultId={vaultId}
            vaultName={vault?.name ?? "…"}
            activePath={activeTab?.path ?? null}
            leftCollapsed={state.left.collapsed}
            rightCollapsed={state.right.collapsed}
            onToggleLeft={() => dispatch({ type: "TOGGLE_LEFT" })}
            onToggleRight={() => dispatch({ type: "TOGGLE_RIGHT" })}
            onOpenSearch={openSearch}
            onOpenPalette={() => setPalette("commands")}
            theme={theme}
            onToggleTheme={toggleTheme}
            onNavigateGuard={navigateGuard}
            exportUrl={api.exportUrl(vaultId)}
          />
        }
        tabBar={<TabBar contentTypeFor={contentTypeFor} onCloseTab={closeTab} />}
        statusBar={
          <StatusBar
            connected={yjsConnected}
            presence={presence}
            sameFileWarning={dismissedWarning ? null : sameFileWarning}
            onDismissWarning={() => setDismissedWarning(true)}
            activeText={activeText}
            syncState={syncState}
          />
        }
        mobileBar={
          <MobileToolbar
            hasActiveTab={activeTab !== null}
            dirty={activeTab?.dirty ?? false}
            saving={saving}
            isMd={activeIsMd}
            mode={activeTab?.mode ?? "preview"}
            onToggleLeft={() => dispatch({ type: "TOGGLE_LEFT" })}
            onNewNote={() => openNewNoteModal()}
            onSave={() => activeTab && saveTab(activeTab)}
            onToggleMode={toggleActiveMode}
            onToggleRight={() => dispatch({ type: "TOGGLE_RIGHT" })}
          />
        }
        left={
          <SidebarContent
            vaultId={vaultId}
            treeNodes={treeNodes}
            manifest={manifest}
            activePath={activeTab?.path ?? null}
            createParent={createParent}
            searchInputRef={searchInputRef}
            onOpenFile={openFile}
            onSelectFolder={(p) => setCreateParent(p)}
            onNewNote={(parent) => openNewNoteModal(parent)}
            onNewFolder={(parent) => openNewFolderModal(parent)}
            onUpload={() => uploadRef.current?.click()}
            onRename={(p) => setModal({ kind: "rename", path: p, value: p, error: null })}
            onDelete={(p) => setModal({ kind: "deleteConfirm", path: p })}
            onMove={handleMove}
          />
        }
        right={
          <RightPanel
            vaultId={vaultId}
            activePath={activeTab?.path ?? null}
            activeSource={activeTab?.editBuffer ?? null}
            onNavigate={openFile}
          />
        }
      >
        <EditorArea
          vaultId={vaultId}
          activeTab={activeTab}
          manifest={manifest}
          load={load}
          saving={saving}
          vaultPaths={vaultPaths}
          onEdit={(buf) =>
            activeTab &&
            dispatch({ type: "EDIT_TAB_BUFFER", id: activeTab.id, editBuffer: buf })
          }
          onSave={() => activeTab && saveTab(activeTab)}
          onRevert={() => activeTab && revertTab(activeTab)}
          onSetMode={(mode) =>
            activeTab && dispatch({ type: "SET_TAB_MODE", id: activeTab.id, mode })
          }
          onRename={(p) => setModal({ kind: "rename", path: p, value: p, error: null })}
          onDelete={(p) => setModal({ kind: "deleteConfirm", path: p })}
          onOpenFile={openFile}
          onCreateNote={(p) => {
            const dir = parentDir(p);
            const name = p.split("/").pop()?.replace(/\.md$/i, "") ?? "";
            setModal({ kind: "newNote", value: name, parent: dir, error: null });
          }}
        />
      </WorkspaceLayout>

      {/* Modals */}
      {modal.kind !== "none" && (
        <ModalRoot onClose={() => setModal({ kind: "none" })}>
          {modal.kind === "newNote" && (
            <ModalForm
              title="New note"
              hint={modal.parent ? `in ${modal.parent}/` : "in vault root"}
              placeholder="Note name"
              value={modal.value}
              error={modal.error}
              submitLabel="Create"
              ghostSuffix=".md"
              onChange={(v) => setModal({ ...modal, value: v, error: null })}
              onSubmit={handleCreateNote}
              onCancel={() => setModal({ kind: "none" })}
            />
          )}
          {modal.kind === "newFolder" && (
            <ModalForm
              title="New folder"
              hint={modal.parent ? `in ${modal.parent}/` : "in vault root"}
              placeholder="Folder name"
              value={modal.value}
              error={modal.error}
              submitLabel="Create"
              onChange={(v) => setModal({ ...modal, value: v, error: null })}
              onSubmit={handleCreateFolder}
              onCancel={() => setModal({ kind: "none" })}
            />
          )}
          {modal.kind === "rename" && (
            <ModalForm
              title="Rename / move"
              value={modal.value}
              error={modal.error}
              submitLabel="Rename"
              onChange={(v) => setModal({ ...modal, value: v, error: null })}
              onSubmit={handleRename}
              onCancel={() => setModal({ kind: "none" })}
            />
          )}
          {modal.kind === "deleteConfirm" && (
            <div className="w-[360px] rounded-lg border border-border bg-surface p-5 shadow-2xl">
              <h3 className="mb-3 text-base font-semibold text-ink">Delete file</h3>
              <p className="mb-4 text-sm text-muted">
                Delete <strong className="text-ink">{modal.path}</strong>?
              </p>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
                  onClick={() => setModal({ kind: "none" })}
                >
                  Cancel
                </button>
                <button
                  className="rounded bg-danger px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
          {modal.kind === "confirm" && (
            <div className="w-[360px] rounded-lg border border-border bg-surface p-5 shadow-2xl">
              <h3 className="mb-3 text-base font-semibold text-ink">{modal.title}</h3>
              <p className="mb-4 text-sm text-muted">{modal.message}</p>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
                  onClick={() => setModal({ kind: "none" })}
                >
                  Cancel
                </button>
                <button
                  className={`rounded px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 ${
                    modal.danger ? "bg-danger" : "bg-accent"
                  }`}
                  onClick={() => {
                    const fn = modal.onConfirm;
                    setModal({ kind: "none" });
                    fn();
                  }}
                >
                  {modal.confirmLabel}
                </button>
              </div>
            </div>
          )}
        </ModalRoot>
      )}

      {palette && (
        <CommandPalette
          mode={palette}
          commands={commands}
          files={vaultPaths}
          onOpenFile={openFile}
          onClose={() => setPalette(null)}
        />
      )}
    </>
  );
}

// ── Sidebar content ──────────────────────────────────────────────────────────

function SidebarContent({
  vaultId,
  treeNodes,
  manifest,
  activePath,
  createParent,
  searchInputRef,
  onOpenFile,
  onSelectFolder,
  onNewNote,
  onNewFolder,
  onUpload,
  onRename,
  onDelete,
  onMove,
}: {
  vaultId: string;
  treeNodes: ReturnType<typeof buildTree>;
  manifest: api.VaultManifest | null;
  activePath: string | null;
  createParent: string;
  searchInputRef: React.RefObject<HTMLInputElement>;
  onOpenFile: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onNewNote: (parent?: string) => void;
  onNewFolder: (parent?: string) => void;
  onUpload: () => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (sourcePath: string, destFolder: string) => void;
}) {
  const createHint = createParent ? createParent : "vault root";
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-1.5 py-1">
        <div className="inline-flex items-center gap-0.5 rounded-md bg-elevated px-0.5 py-0.5">
          <button
            onClick={() => onNewNote(createParent)}
            className="flex h-9 w-9 items-center justify-center rounded text-ink transition-colors hover:bg-hover"
            title={`New note in ${createHint} (⌘N)`}
          >
            <FilePlus size={22} weight="bold" />
          </button>
          <button
            onClick={() => onNewFolder(createParent)}
            className="flex h-9 w-9 items-center justify-center rounded text-ink transition-colors hover:bg-hover"
            title={`New folder in ${createHint}`}
          >
            <FolderPlus size={22} weight="bold" />
          </button>
          <button
            onClick={onUpload}
            className="flex h-9 w-9 items-center justify-center rounded text-ink transition-colors hover:bg-hover"
            title="Upload file"
          >
            <UploadSimple size={22} weight="bold" />
          </button>
        </div>
        {createParent ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-faint" title={createParent}>
            {createParent}/
          </span>
        ) : (
          <span className="text-[11px] text-faint">/</span>
        )}
      </div>

      <div className="border-b border-border px-2 py-2">
        <SearchPanel vaultId={vaultId} onSelect={onOpenFile} inputRef={searchInputRef} />
      </div>

      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {!manifest ? (
          <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>
        ) : treeNodes.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted">This vault is empty.</p>
        ) : (
          <FolderTree
            nodes={treeNodes}
            selectedPath={activePath}
            focusedFolder={createParent}
            onSelect={onOpenFile}
            onSelectFolder={onSelectFolder}
            onRename={onRename}
            onDelete={onDelete}
            onNewNote={onNewNote}
            onNewFolder={onNewFolder}
            onMove={onMove}
          />
        )}
      </div>

      <div className="border-t border-border">
        <SnapshotsPanel vaultId={vaultId} />
      </div>
    </>
  );
}

// ── Editor area ──────────────────────────────────────────────────────────--

function EditorArea({
  vaultId,
  activeTab,
  manifest,
  load,
  saving,
  vaultPaths,
  onEdit,
  onSave,
  onRevert,
  onSetMode,
  onRename,
  onDelete,
  onOpenFile,
  onCreateNote,
}: {
  vaultId: string;
  activeTab: Tab | null;
  manifest: api.VaultManifest | null;
  load: { tabId: string; status: "loading" | "error"; message?: string } | null;
  saving: boolean;
  vaultPaths: string[];
  onEdit: (buffer: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onSetMode: (mode: "live" | "preview") => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCreateNote: (path: string) => void;
}) {
  // Cmd/Ctrl+S to save the active tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab?.dirty) onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab?.dirty, onSave]);

  if (!activeTab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <TextAlignLeft size={40} weight="duotone" className="text-faint" />
        <p className="text-sm">Select a file to open it.</p>
      </div>
    );
  }

  // Wait for the manifest before deciding a tab is missing (cold-start race).
  if (!manifest) {
    return <CenterMessage>Loading…</CenterMessage>;
  }

  const entry = manifest.entries[activeTab.path.toLowerCase()];
  const noteTitle = activeTab.path.split("/").pop()?.replace(/\.md$/i, "") ?? activeTab.path;

  if (load && load.tabId === activeTab.id && load.status === "loading") {
    return <CenterMessage>Loading…</CenterMessage>;
  }
  if (load && load.tabId === activeTab.id && load.status === "error") {
    return <CenterMessage tone="danger">{load.message}</CenterMessage>;
  }
  if (!entry) {
    return <CenterMessage tone="danger">File not in manifest</CenterMessage>;
  }

  // Image
  if (isImageType(entry.contentType)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <FileToolbar
          dirty={false}
          saving={false}
          onRename={() => onRename(activeTab.path)}
          onDelete={() => onDelete(activeTab.path)}
        />
        <div className="custom-scroll flex-1 overflow-auto p-6">
          <img
            src={`${api.fileUrl(vaultId, activeTab.path)}?rev=${entry.revision}`}
            alt={activeTab.path}
            className="mx-auto block max-w-full rounded"
          />
        </div>
      </div>
    );
  }

  // Binary
  if (!isTextType(entry.contentType)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <FileToolbar
          dirty={false}
          saving={false}
          onRename={() => onRename(activeTab.path)}
          onDelete={() => onDelete(activeTab.path)}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
          <p className="text-sm">
            {entry.contentType} · {formatBytes(entry.size)}
          </p>
          <a
            href={`${api.fileUrl(vaultId, activeTab.path)}?rev=${entry.revision}`}
            download={activeTab.path.split("/").pop()}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-soft"
          >
            <DownloadSimple size={15} /> Download
          </a>
        </div>
      </div>
    );
  }

  // Text / markdown
  const md = isMarkdown(entry.contentType, activeTab.path);
  const buffer = activeTab.editBuffer ?? "";
  const previewMode = md && activeTab.mode === "preview";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileToolbar
        mode={md ? activeTab.mode : undefined}
        onToggleMode={md ? () => onSetMode(activeTab.mode === "preview" ? "live" : "preview") : undefined}
        dirty={activeTab.dirty}
        saving={saving}
        onSave={onSave}
        onRevert={onRevert}
        onRename={() => onRename(activeTab.path)}
        onDelete={() => onDelete(activeTab.path)}
      />
      {previewMode ? (
        <div className="custom-scroll min-h-0 flex-1 overflow-y-auto">
          <MarkdownView
            source={buffer}
            vaultId={vaultId}
            currentPath={activeTab.path}
            title={noteTitle}
            vaultPaths={vaultPaths}
            manifestEntries={manifest.entries}
            onCreateNote={onCreateNote}
            onNavigate={onOpenFile}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {md && (
            <div className="mx-auto w-full max-w-[820px] px-8 pt-5">
              <h1 className="note-inline-title">{noteTitle}</h1>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <MarkdownEditor
              docKey={activeTab.id}
              currentPath={activeTab.path}
              value={buffer}
              onChange={onEdit}
              onSave={onSave}
              livePreviewEnabled={md}
              vaultId={vaultId}
              vaultPaths={vaultPaths}
              onOpenLink={onOpenFile}
              fileUrl={api.fileUrl}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FileToolbar({
  mode,
  onToggleMode,
  dirty,
  saving,
  onSave,
  onRevert,
  onRename,
  onDelete,
}: {
  mode?: "live" | "preview";
  onToggleMode?: () => void;
  dirty: boolean;
  saving: boolean;
  onSave?: () => void;
  onRevert?: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 border-b border-border bg-secondary px-2">
      {onRevert && (
        <button
          onClick={onRevert}
          disabled={!dirty || saving}
          title="Revert to vault version"
          aria-label="Revert"
          className="flex h-9 w-9 items-center justify-center rounded text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowCounterClockwise size={22} weight="bold" />
        </button>
      )}
      {onSave && (
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          title={saving ? "Saving…" : "Save"}
          aria-label="Save"
          className="flex h-9 items-center gap-1.5 rounded px-2 text-[13px] font-medium text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FloppyDisk size={22} weight="bold" />
          {saving ? "Saving…" : dirty ? "Save" : ""}
        </button>
      )}
      <button
        onClick={onRename}
        title="Rename"
        aria-label="Rename"
        className="flex h-9 w-9 items-center justify-center rounded text-ink hover:bg-hover"
      >
        <PencilSimple size={22} weight="bold" />
      </button>
      <button
        onClick={onDelete}
        title="Delete"
        aria-label="Delete"
        className="flex h-9 w-9 items-center justify-center rounded text-ink hover:bg-hover hover:text-danger"
      >
        <Trash size={22} weight="bold" />
      </button>
      {onToggleMode && mode && (
        <>
          <div className="mx-1 h-4 w-px bg-border" aria-hidden />
          <button
            onClick={onToggleMode}
            title={mode === "preview" ? "Switch to edit" : "Switch to preview"}
            aria-label={mode === "preview" ? "Preview mode, switch to edit" : "Edit mode, switch to preview"}
            className="flex h-9 items-center gap-1.5 rounded-md px-2 text-ink transition-colors hover:bg-hover"
          >
            {mode === "preview" ? (
              <Eye size={22} weight="bold" />
            ) : (
              <PencilSimple size={22} weight="bold" />
            )}
            {/* Both labels occupy the same cell so width never shifts. */}
            <span className="grid text-[13px] font-medium leading-none">
              <span
                className={mode === "live" ? "visible" : "invisible"}
                style={{ gridArea: "1 / 1" }}
              >
                Edit
              </span>
              <span
                className={mode === "preview" ? "visible" : "invisible"}
                style={{ gridArea: "1 / 1" }}
              >
                Preview
              </span>
            </span>
          </button>
        </>
      )}
    </div>
  );
}

function CenterMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className={tone === "danger" ? "text-danger" : "text-muted"}>{children}</p>
    </div>
  );
}

// ── Modal primitives (enhanced in Phase 8) ─────────────────────────────────--

function ModalRoot({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        boxRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    // Focus the first focusable (unless an autoFocus input already grabbed it).
    requestAnimationFrame(() => {
      if (boxRef.current && !boxRef.current.contains(document.activeElement)) {
        focusables()[0]?.focus();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !boxRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalForm({
  title,
  hint,
  placeholder,
  value,
  error,
  submitLabel,
  ghostSuffix,
  onChange,
  onSubmit,
  onCancel,
}: {
  title: string;
  hint?: string;
  placeholder?: string;
  value: string;
  error: string | null;
  submitLabel: string;
  /** Ghost suffix shown after the input (e.g. ".md"). */
  ghostSuffix?: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const showGhost = Boolean(ghostSuffix);

  return (
    <div className="w-[400px] rounded-lg border border-border bg-surface p-5 shadow-2xl">
      <h3 className="mb-1 text-base font-semibold text-ink">{title}</h3>
      {hint && <p className="mb-3 text-[12px] text-muted">{hint}</p>}
      <div
        className={`mb-2 flex items-center rounded border border-border bg-canvas focus-within:border-accent ${
          ghostSuffix ? "pr-3" : ""
        }`}
      >
        <input
          autoFocus
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-sans text-sm text-ink outline-none"
        />
        {showGhost && (
          <span aria-hidden className="shrink-0 select-none font-sans text-sm text-faint">
            {ghostSuffix}
          </span>
        )}
      </div>
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
