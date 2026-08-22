import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../api";
import { FolderTree, buildTree } from "../components/FolderTree";
import MarkdownView from "../components/MarkdownView";
import SearchPanel from "../components/SearchPanel";
import SnapshotsPanel from "../components/SnapshotsPanel";
import RightPanel from "../components/layout/RightPanel";
import MarkdownEditor from "../components/editor/MarkdownEditor";
import { useTheme } from "../hooks/useTheme";
import { useVaultNotify } from "../hooks/useVaultNotify";
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
  UploadSimple,
  PencilSimple,
  Eye,
  Trash,
  TextAlignLeft,
  DownloadSimple,
  MagnifyingGlass,
  SidebarSimple,
  SidebarSimple as SidebarRightIcon,
  Sun,
  Moon,
  FloppyDisk,
  ArrowCounterClockwise,
  X as XIcon,
  DeviceMobile,
  House,
  FileMagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { deviceAuthor } from "../identity";
import { useToast } from "../components/ui/Toast";
import CommandPalette, {
  type Command,
  type PaletteMode,
} from "../components/overlays/CommandPalette";
import ConflictResolutionPanel, {
  ConflictBanner,
} from "../components/ConflictResolutionPanel";

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

function applyUnifiedPatch(original: string, patch: string): string | null {
  const lines = patch.split("\n");
  const hunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  if (hunkIndex < 0) return null;
  const match = lines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;

  const source = original === "" ? [] : original.split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  const start = Number(match[1]) - 1;
  while (sourceIndex < start) output.push(source[sourceIndex++]);
  for (const line of lines.slice(hunkIndex + 1)) {
    if (line === "") continue;
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      if (source[sourceIndex] !== content) return null;
      output.push(content);
      sourceIndex++;
    } else if (prefix === "-") {
      if (source[sourceIndex] !== content) return null;
      sourceIndex++;
    } else if (prefix === "+") {
      output.push(content);
    }
  }
  while (sourceIndex < source.length) output.push(source[sourceIndex++]);
  return output.join("\n");
}

type Modal =
  | { kind: "none" }
  | { kind: "newNote"; value: string; error: string | null }
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
  const [manifest, setManifest] = useState<api.VaultManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [conflicts, setConflicts] = useState<api.ConflictPayload[]>([]);
  const [selectedConflictNote, setSelectedConflictNote] = useState<string | null>(
    null
  );
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [load, setLoad] = useState<{
    tabId: string;
    status: "loading" | "error";
    message?: string;
  } | null>(null);
  const [dismissedWarning, setDismissedWarning] = useState(false);

  const uploadRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialRouteHandled = useRef(false);
  const activeTabRef = useRef<Tab | null>(activeTab);
  const tabsRef = useRef(state.tabs);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    tabsRef.current = state.tabs;
  }, [state.tabs]);

  const anyDirty = state.tabs.some((t) => t.dirty);

  // ── Data loading ──────────────────────────────────────────────────────────

  const refreshManifest = useCallback(async (): Promise<api.VaultManifest | null> => {
    try {
      const m = await api.getManifest(vaultId);
      setManifest(m);
      return m;
    } catch (e) {
      setManifestError((e as Error).message);
      return null;
    }
  }, [vaultId]);

  const refreshConflicts = useCallback(async (): Promise<
    api.ConflictPayload[]
  > => {
    try {
      const next = await api.getConflicts(vaultId);
      setConflicts(next);
      return next;
    } catch {
      return [];
    }
  }, [vaultId]);

  useEffect(() => {
    api.getVault(vaultId).then(setVault).catch(() => {});
    api.getSession().then((session) => setSessionId(session?.session?.id ?? null)).catch(() => setSessionId(null));
    refreshManifest();
    refreshConflicts();
  }, [vaultId, refreshManifest, refreshConflicts]);

  // ── Open a file in a tab ────────────────────────────────────────────────--

  const openFile = useCallback(
    (path: string) => {
      dispatch({ type: "OPEN_FILE", path });
      // On mobile, close the file tree drawer after opening a file.
      if (isMobile && !state.left.collapsed) {
        dispatch({ type: "TOGGLE_LEFT", collapsed: true });
      }
    },
    [dispatch, isMobile, state.left.collapsed]
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
    if (!activeTab || !manifest) return;
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
    let cancelled = false;
    setLoad({ tabId: activeTab.id, status: "loading" });
    api
      .getFileText(vaultId, activeTab.path)
      .then((content) => {
        if (cancelled) return;
        dispatch({
          type: "SET_TAB_CONTENT",
          id: activeTab.id,
          editBuffer: content,
          baseContent: content,
          baseRevision: entry.revision,
        });
        void api.postAcks(vaultId, [
          { path: entry.path, revision: entry.revision },
        ]).catch((error) => {
          console.warn("[lapis] failed to acknowledge loaded revision", error);
        });
        setLoad(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoad({ tabId: activeTab.id, status: "error", message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.id, activeTab?.path, activeTab?.baseContent, manifest, vaultId, dispatch]);

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
        const baseRevision = tab.baseRevision ?? 0;
        const result = await api.putTextFile(vaultId, tab.path, tab.editBuffer, {
          baseRevision,
        });
        await refreshManifest();
        if (result.conflict) {
          const conflict = result.conflict;
          setConflicts((current) => [
            ...current.filter(
              (item) => item.conflictNote !== conflict.conflictNote
            ),
            conflict,
          ]);
          setSelectedConflictNote(conflict.conflictNote);
          setConflictError(null);
          toast(`Conflict saved to ${conflict.conflictNote}`, {
            tone: "error",
          });
          return;
        }
        if (result.conflictNote) {
          toast(`Conflict saved to ${result.conflictNote}`, { tone: "error" });
          return;
        }
        const savedContent =
          result.revision > baseRevision + 1
            ? await api.getFileText(vaultId, result.path)
            : tab.editBuffer;
        void api.postAcks(vaultId, [
          { path: result.path, revision: result.revision },
        ]).catch((error) => {
          console.warn("[lapis] failed to acknowledge saved revision", error);
        });
        dispatch({
          type: "MARK_TAB_SAVED",
          id: tab.id,
          content: savedContent,
          revision: result.revision,
        });
        toast("Saved", { tone: "success", duration: 1500 });
      } catch (e) {
        toast((e as Error).message, { tone: "error" });
      } finally {
        setSaving(false);
      }
    },
    [vaultId, refreshManifest, dispatch, toast]
  );

  // ── Revert the active tab to the server version ──────────────────────────--

  const doRevert = useCallback(
    async (tab: Tab) => {
      try {
        const content = await api.getFileText(vaultId, tab.path);
        const m = await refreshManifest();
        const entry = m?.entries[tab.path.toLowerCase()];
        dispatch({
          type: "SET_TAB_CONTENT",
          id: tab.id,
          editBuffer: content,
          baseContent: content,
          baseRevision: entry?.revision ?? tab.baseRevision ?? 0,
        });
        toast("Reverted to server version", { tone: "success", duration: 1500 });
      } catch (e) {
        toast((e as Error).message, { tone: "error" });
      }
    },
    [vaultId, refreshManifest, dispatch, toast]
  );

  const revertTab = useCallback(
    (tab: Tab) => {
      setModal({
        kind: "confirm",
        title: "Revert to server version?",
        message: `Discard your local changes to ${tab.path} and reload the version saved on the server?`,
        confirmLabel: "Revert",
        danger: true,
        onConfirm: () => void doRevert(tab),
      });
    },
    [doRevert]
  );

  const selectedConflict =
    conflicts.find(
      (conflict) => conflict.conflictNote === selectedConflictNote
    ) ?? null;

  const reviewConflicts = useCallback(() => {
    const first = conflicts[0];
    if (!first) return;
    setConflictError(null);
    setSelectedConflictNote(first.conflictNote);
  }, [conflicts]);

  const resolveSelectedConflict = useCallback(
    async (
      action: api.ConflictResolutionAction,
      content?: string
    ): Promise<void> => {
      if (!selectedConflict) return;
      setResolvingConflict(true);
      setConflictError(null);
      try {
        const result = await api.resolveConflict(vaultId, {
          path: selectedConflict.path,
          conflictNote: selectedConflict.conflictNote,
          action,
          content,
        });
        const resolvedContent = await api.getFileText(
          vaultId,
          result.entry.path
        );
        const tab = tabsRef.current.find(
          (candidate) =>
            candidate.path.toLowerCase() === result.entry.path.toLowerCase()
        );
        if (tab) {
          dispatch({
            type: "SET_TAB_CONTENT",
            id: tab.id,
            editBuffer: resolvedContent,
            baseContent: resolvedContent,
            baseRevision: result.entry.revision,
          });
        }
        void api
          .postAcks(vaultId, [
            { path: result.entry.path, revision: result.entry.revision },
          ])
          .catch((error) => {
            console.warn(
              "[lapis] failed to acknowledge resolved revision",
              error
            );
          });
        const remaining = conflicts.filter(
          (conflict) => conflict.conflictNote !== result.conflictNote
        );
        setConflicts(remaining);
        setSelectedConflictNote(remaining[0]?.conflictNote ?? null);
        await refreshManifest();
        toast("Conflict resolved", { tone: "success", duration: 2000 });
      } catch (error) {
        setConflictError((error as Error).message);
      } finally {
        setResolvingConflict(false);
      }
    },
    [
      selectedConflict,
      vaultId,
      conflicts,
      dispatch,
      refreshManifest,
      toast,
    ]
  );

  // ── Remote changes ─────────────────────────────────────────────────────--

  const handleRemoteChange = useCallback(
    async (msg: import("../hooks/useVaultNotify").ChangeNotification) => {
      if (sessionId && msg.author === deviceAuthor("web", sessionId)) {
        return;
      }
      if (msg.path.startsWith(".sync-conflicts/")) {
        void refreshConflicts();
      }
      const next = await refreshManifest();
      const key = msg.path.toLowerCase();
      if (msg.kind === "delete") {
        const tab = tabsRef.current.find((t) => t.path.toLowerCase() === key);
        if (tab && !tab.dirty) dispatch({ type: "REMOVE_PATH", path: tab.path });
        return;
      }
      if (msg.kind === "rename" && msg.newPath) {
        const tab = tabsRef.current.find((t) => t.path.toLowerCase() === key);
        if (tab && !tab.dirty) {
          dispatch({ type: "RENAME_PATH", oldPath: tab.path, newPath: msg.newPath });
        }
        return;
      }
      if (msg.kind === "put") {
        const tab = tabsRef.current.find((t) => t.path.toLowerCase() === key);
        if (tab && !tab.dirty && next) {
          const entry = next.entries[key];
          if (entry && isTextType(entry.contentType)) {
            if (
              msg.patch &&
              msg.revision !== undefined &&
              msg.baseRevision !== undefined &&
              tab.baseContent !== undefined &&
              tab.baseRevision === msg.baseRevision
            ) {
              const patched = applyUnifiedPatch(tab.baseContent, msg.patch);
              if (patched !== null) {
                dispatch({
                  type: "SET_TAB_CONTENT",
                  id: tab.id,
                  editBuffer: patched,
                  baseContent: patched,
                  baseRevision: msg.revision,
                });
                return;
              }
            }
            try {
              const content = await api.getFileText(vaultId, tab.path);
              dispatch({
                type: "SET_TAB_CONTENT",
                id: tab.id,
                editBuffer: content,
                baseContent: content,
                baseRevision: entry.revision,
              });
            } catch {
              /* ignore */
            }
          }
        }
      }
    },
    [refreshManifest, refreshConflicts, dispatch, vaultId, sessionId]
  );

  const handleConflict = useCallback(
    (msg: import("../hooks/useVaultNotify").ConflictNotification) => {
      setConflicts((current) => [
        ...current.filter(
          (conflict) =>
            conflict.conflictNote !== msg.conflict.conflictNote
        ),
        msg.conflict,
      ]);
      setSelectedConflictNote(
        (current) => current ?? msg.conflict.conflictNote
      );
      toast(`Sync conflict: ${msg.conflict.path}`, {
        tone: "error",
        duration: 5000,
      });
    },
    [toast]
  );

  const handleConflictResolved = useCallback(
    (msg: import("../hooks/useVaultNotify").ConflictResolvedNotification) => {
      setConflicts((current) =>
        current.filter(
          (conflict) => conflict.conflictNote !== msg.conflictNote
        )
      );
      setSelectedConflictNote((current) =>
        current === msg.conflictNote ? null : current
      );
      void refreshManifest();
    },
    [refreshManifest]
  );

  const { connected, presence, sameFileWarning } = useVaultNotify(
    vaultId,
    activeTab?.path ?? null,
    {
      onChange: (msg) => void handleRemoteChange(msg),
      onConflict: handleConflict,
      onConflictResolved: handleConflictResolved,
      onReconnect: () => {
        void refreshManifest();
        void refreshConflicts();
      },
    }
  );

  useEffect(() => {
    if (sameFileWarning) setDismissedWarning(false);
  }, [sameFileWarning?.path]);

  // ── Create / upload / rename / delete ──────────────────────────────────--

  async function handleCreateNote() {
    if (modal.kind !== "newNote") return;
    let path = modal.value.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";
    try {
      await api.putTextFile(vaultId, path, "");
      await refreshManifest();
      setModal({ kind: "none" });
      dispatch({ type: "OPEN_FILE", path });
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
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
    await refreshManifest();
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
      await api.renameFile(vaultId, modal.path, newPath);
      await refreshManifest();
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
      await api.deleteFile(vaultId, path);
      await refreshManifest();
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
  const syncState: SyncState = saving
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
        run: () => setModal({ kind: "newNote", value: "", error: null }),
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

    if (conflicts.length > 0) {
      list.push({
        id: "review-conflicts",
        title: `Review sync conflicts (${conflicts.length})`,
        keywords: "resolve merge versions",
        icon: <Warning size={16} weight="fill" className="text-danger" />,
        run: reviewConflicts,
      });
      for (const conflict of conflicts) {
        list.push({
          id: `resolve-${conflict.conflictNote}`,
          title: `Resolve conflict: ${conflict.path}`,
          keywords: `${conflict.conflictNote} merge server yours base`,
          icon: <Warning size={16} className="text-danger" />,
          run: () => {
            setConflictError(null);
            setSelectedConflictNote(conflict.conflictNote);
          },
        });
      }
    }

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
    conflicts,
    reviewConflicts,
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
        setModal({ kind: "newNote", value: "", error: null });
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
            connected={connected}
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
            onNewNote={() => setModal({ kind: "newNote", value: "", error: null })}
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
            manifestError={manifestError}
            activePath={activeTab?.path ?? null}
            searchInputRef={searchInputRef}
            onOpenFile={openFile}
            onNewNote={() => setModal({ kind: "newNote", value: "", error: null })}
            onUpload={() => uploadRef.current?.click()}
            onRename={(p) => setModal({ kind: "rename", path: p, value: p, error: null })}
            onDelete={(p) => setModal({ kind: "deleteConfirm", path: p })}
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
        {conflicts.length > 0 && (
          <ConflictBanner count={conflicts.length} onReview={reviewConflicts} />
        )}
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
          onCreateNote={(p) => setModal({ kind: "newNote", value: p, error: null })}
        />
      </WorkspaceLayout>

      {/* Modals */}
      {modal.kind !== "none" && (
        <ModalRoot onClose={() => setModal({ kind: "none" })}>
          {modal.kind === "newNote" && (
            <ModalForm
              title="New note"
              placeholder="path/to/note.md"
              value={modal.value}
              error={modal.error}
              submitLabel="Create"
              onChange={(v) => setModal({ ...modal, value: v, error: null })}
              onSubmit={handleCreateNote}
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
                  className="rounded bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
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
                  className={`rounded px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 ${
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

      {selectedConflict && (
        <ConflictResolutionPanel
          conflict={selectedConflict}
          resolving={resolvingConflict}
          error={conflictError}
          onClose={() => {
            if (!resolvingConflict) {
              setSelectedConflictNote(null);
              setConflictError(null);
            }
          }}
          onResolve={resolveSelectedConflict}
        />
      )}
    </>
  );
}

// ── Sidebar content ──────────────────────────────────────────────────────--

function SidebarContent({
  vaultId,
  treeNodes,
  manifest,
  manifestError,
  activePath,
  searchInputRef,
  onOpenFile,
  onNewNote,
  onUpload,
  onRename,
  onDelete,
}: {
  vaultId: string;
  treeNodes: ReturnType<typeof buildTree>;
  manifest: api.VaultManifest | null;
  manifestError: string | null;
  activePath: string | null;
  searchInputRef: React.RefObject<HTMLInputElement>;
  onOpenFile: (path: string) => void;
  onNewNote: () => void;
  onUpload: () => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          onClick={onNewNote}
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-2 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-soft"
          title="New note (⌘N)"
        >
          <FilePlus size={15} weight="bold" /> Note
        </button>
        <button
          onClick={onUpload}
          className="flex items-center justify-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
          title="Upload file"
        >
          <UploadSimple size={15} /> Upload
        </button>
      </div>

      <div className="border-b border-border px-2 py-2">
        <SearchPanel vaultId={vaultId} onSelect={onOpenFile} inputRef={searchInputRef} />
      </div>

      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {manifestError ? (
          <p className="px-3 py-2 text-[13px] text-danger">{manifestError}</p>
        ) : !manifest ? (
          <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>
        ) : treeNodes.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted">This vault is empty.</p>
        ) : (
          <FolderTree
            nodes={treeNodes}
            selectedPath={activePath}
            onSelect={onOpenFile}
            onRename={onRename}
            onDelete={onDelete}
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

  const entry = manifest?.entries[activeTab.path.toLowerCase()];

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
        <FileHeader path={activeTab.path} onRename={onRename} onDelete={onDelete} />
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
        <FileHeader path={activeTab.path} onRename={onRename} onDelete={onDelete} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
          <p className="text-sm">
            {entry.contentType} · {formatBytes(entry.size)}
          </p>
          <a
            href={`${api.fileUrl(vaultId, activeTab.path)}?rev=${entry.revision}`}
            download={activeTab.path.split("/").pop()}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft"
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
      <FileHeader
        path={activeTab.path}
        onRename={onRename}
        onDelete={onDelete}
        right={
          md ? (
            <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
              <ModeButton
                active={activeTab.mode === "live"}
                onClick={() => onSetMode("live")}
                icon={<PencilSimple size={13} />}
                label="Edit"
              />
              <ModeButton
                active={activeTab.mode === "preview"}
                onClick={() => onSetMode("preview")}
                icon={<Eye size={13} />}
                label="Preview"
              />
            </div>
          ) : undefined
        }
        saving={saving}
        dirty={activeTab.dirty}
        onSave={onSave}
        onRevert={onRevert}
      />
      {previewMode ? (
        <div className="custom-scroll min-h-0 flex-1 overflow-y-auto">
          <MarkdownView
            source={buffer}
            vaultId={vaultId}
            currentPath={activeTab.path}
            vaultPaths={vaultPaths}
            manifestEntries={manifest?.entries}
            onCreateNote={onCreateNote}
            onNavigate={onOpenFile}
          />
        </div>
      ) : (
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
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium transition-colors",
        active ? "bg-accent text-white" : "text-muted hover:text-ink",
      ].join(" ")}
    >
      {icon} {label}
    </button>
  );
}

function FileHeader({
  path,
  onDelete,
  right,
  saving,
  dirty,
  onSave,
  onRevert,
}: {
  path: string;
  onRename?: (path: string) => void;
  onDelete: (path: string) => void;
  right?: React.ReactNode;
  saving?: boolean;
  dirty?: boolean;
  onSave?: () => void;
  onRevert?: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-end gap-0.5 border-b border-border bg-canvas px-2">
      <span className="flex-1 truncate font-mono text-[12px] text-muted">{path}</span>
      {right}
      {onRevert && (
        <button
          onClick={onRevert}
          disabled={!dirty || saving}
          title="Revert to server version"
          aria-label="Revert to server version"
          className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowCounterClockwise size={13} /> Revert
        </button>
      )}
      {onSave && (
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
      <button
        onClick={() => onDelete(path)}
        title="Delete"
        aria-label="Delete"
        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-danger"
      >
        <Trash size={14} />
      </button>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
  placeholder,
  value,
  error,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  title: string;
  placeholder?: string;
  value: string;
  error: string | null;
  submitLabel: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="w-[400px] rounded-lg border border-border bg-surface p-5 shadow-2xl">
      <h3 className="mb-3 text-base font-semibold text-ink">{title}</h3>
      <input
        autoFocus
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        className="mb-2 w-full rounded border border-border bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
      />
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
