import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../api";
import { FolderTree, buildTree } from "../components/FolderTree";
import MarkdownView from "../components/MarkdownView";
import SearchPanel from "../components/SearchPanel";
import BacklinksPanel from "../components/BacklinksPanel";
import PresenceBar from "../components/PresenceBar";
import { useTheme, type Theme } from "../hooks/useTheme";
import { useVaultNotify } from "../hooks/useVaultNotify";
import SnapshotsPanel from "../components/SnapshotsPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

type FileViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "text"; content: string; path: string; contentType: string }
  | { kind: "image"; path: string; contentType: string }
  | { kind: "binary"; path: string; contentType: string; size: number }
  | { kind: "editing"; content: string; path: string; saving: boolean }
  | { kind: "error"; message: string };

type Modal =
  | { kind: "none" }
  | { kind: "newNote"; value: string; error: string | null }
  | { kind: "rename"; path: string; value: string; error: string | null }
  | { kind: "deleteConfirm"; path: string };

const TEXT_TYPES = ["text/", "application/json", "application/xml"];
const IMAGE_TYPES = ["image/"];

function isTextType(ct: string): boolean {
  return TEXT_TYPES.some((t) => ct.startsWith(t));
}
function isImageType(ct: string): boolean {
  return IMAGE_TYPES.some((t) => ct.startsWith(t));
}

// ── Page component ────────────────────────────────────────────────────────────

export default function VaultBrowserPage() {
  const { id: vaultId } = useParams<{ id: string }>();
  const [vault, setVault] = useState<api.Vault | null>(null);
  const [manifest, setManifest] = useState<api.VaultManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileViewState>({ kind: "idle" });
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const uploadRef = useRef<HTMLInputElement>(null);
  const { theme, setTheme } = useTheme();

  // ── Live notifications (Slice 10) ───────────────────────────────────────────

  const [dismissedWarning, setDismissedWarning] = useState(false);
  // Stable ref to refreshManifest — updated after it's defined below
  const refreshManifestRef = useRef<() => Promise<void>>(async () => {});

  const { connected, presence, sameFileWarning } = useVaultNotify(
    vaultId,
    selectedPath,
    {
      onChange: useCallback(() => {
        void refreshManifestRef.current();
      }, []),
      onReconnect: useCallback(() => {
        void refreshManifestRef.current();
      }, []),
    }
  );

  // Reset dismissed state whenever a new warning arrives for a new path
  useEffect(() => {
    if (sameFileWarning) setDismissedWarning(false);
  }, [sameFileWarning?.path]);

  // ── Data loading ────────────────────────────────────────────────────────────

  const refreshManifest = useCallback(async () => {
    if (!vaultId) return;
    try {
      const m = await api.getManifest(vaultId);
      setManifest(m);
    } catch (e) {
      setManifestError((e as Error).message);
    }
  }, [vaultId]);

  // Keep ref in sync with the latest refreshManifest
  useEffect(() => {
    refreshManifestRef.current = refreshManifest;
  }, [refreshManifest]);

  useEffect(() => {
    if (!vaultId) return;
    api.getVault(vaultId).then(setVault).catch(() => {});
    refreshManifest();
  }, [vaultId, refreshManifest]);

  // ── File opening ────────────────────────────────────────────────────────────

  const openFile = useCallback(
    async (path: string) => {
      if (!vaultId) return;
      setSelectedPath(path);

      const entry = manifest?.entries[path.toLowerCase()];
      if (!entry) {
        setFileView({ kind: "error", message: "File not in manifest" });
        return;
      }

      if (isImageType(entry.contentType)) {
        setFileView({ kind: "image", path, contentType: entry.contentType });
        return;
      }

      if (isTextType(entry.contentType)) {
        setFileView({ kind: "loading" });
        try {
          const content = await api.getFileText(vaultId, path);
          setFileView({ kind: "text", content, path, contentType: entry.contentType });
        } catch (e) {
          setFileView({ kind: "error", message: (e as Error).message });
        }
        return;
      }

      setFileView({
        kind: "binary",
        path,
        contentType: entry.contentType,
        size: entry.size,
      });
    },
    [vaultId, manifest]
  );

  // ── Create new note ─────────────────────────────────────────────────────────

  function openNewNoteModal() {
    setModal({ kind: "newNote", value: "", error: null });
  }

  async function handleCreateNote() {
    if (modal.kind !== "newNote" || !vaultId) return;
    let path = modal.value.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";

    try {
      await api.putTextFile(vaultId, path, "");
      await refreshManifest();
      setModal({ kind: "none" });
      openFile(path);
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
    }
  }

  // ── Edit (save) ─────────────────────────────────────────────────────────────

  async function handleSaveEdit(path: string, content: string) {
    if (!vaultId) return;
    if (fileView.kind !== "editing") return;
    setFileView({ kind: "editing", path, content, saving: true });
    try {
      await api.putTextFile(vaultId, path, content);
      await refreshManifest();
      setFileView({ kind: "text", content, path, contentType: "text/markdown" });
    } catch (e) {
      setFileView({ kind: "editing", path, content, saving: false });
      alert((e as Error).message);
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function handleUpload(files: FileList | null) {
    if (!files || !vaultId) return;
    for (const file of Array.from(files)) {
      try {
        await api.uploadFile(vaultId, file.name, file);
      } catch (e) {
        alert(`Upload failed for ${file.name}: ${(e as Error).message}`);
      }
    }
    await refreshManifest();
  }

  // ── Rename ──────────────────────────────────────────────────────────────────

  function openRenameModal(path: string) {
    setModal({ kind: "rename", path, value: path, error: null });
  }

  async function handleRename() {
    if (modal.kind !== "rename" || !vaultId) return;
    const newPath = modal.value.trim();
    if (!newPath || newPath === modal.path) {
      setModal({ kind: "none" });
      return;
    }
    try {
      await api.renameFile(vaultId, modal.path, newPath);
      await refreshManifest();
      setModal({ kind: "none" });
      if (selectedPath === modal.path) {
        setSelectedPath(newPath);
        openFile(newPath);
      }
    } catch (e) {
      setModal({ ...modal, error: (e as Error).message });
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  function openDeleteModal(path: string) {
    setModal({ kind: "deleteConfirm", path });
  }

  async function handleDelete() {
    if (modal.kind !== "deleteConfirm" || !vaultId) return;
    const { path } = modal;
    try {
      await api.deleteFile(vaultId, path);
      await refreshManifest();
      setModal({ kind: "none" });
      if (selectedPath === path) {
        setSelectedPath(null);
        setFileView({ kind: "idle" });
      }
    } catch (e) {
      alert((e as Error).message);
      setModal({ kind: "none" });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const treeNodes =
    manifest ? buildTree(Object.values(manifest.entries)) : [];

  return (
    <div style={styles.shell}>
      {/* Hidden file input for uploads */}
      <input
        ref={uploadRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleUpload(e.target.files)}
      />

      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Link to="/" style={styles.backLink}>
              ← Vaults
            </Link>
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
              {vaultId && (
                <Link to={`/vault/${vaultId}/devices`} style={styles.devicesLink}>
                  Devices
                </Link>
              )}
              {vaultId && (
                <a
                  href={api.exportUrl(vaultId)}
                  download
                  style={styles.devicesLink}
                  title="Download vault as zip"
                >
                  Export
                </a>
              )}
            </div>
          </div>
          <span style={styles.vaultName}>{vault?.name ?? "…"}</span>
        </div>

        {/* Live presence bar */}
        <PresenceBar
          connected={connected}
          presence={presence}
          sameFileWarning={dismissedWarning ? null : sameFileWarning}
          onDismissWarning={() => setDismissedWarning(true)}
        />

        <div style={styles.sidebarActions}>
          <button style={styles.actionBtn} title="New note" onClick={openNewNoteModal}>
            + Note
          </button>
          <button
            style={styles.actionBtn}
            title="Upload file"
            onClick={() => uploadRef.current?.click()}
          >
            ↑ Upload
          </button>
        </div>

        <div style={styles.themeRow}>
          {(["light", "dark", "sepia"] as Theme[]).map((t) => (
            <button
              key={t}
              style={{
                ...styles.themeBtn,
                ...(theme === t ? styles.themeBtnActive : {}),
              }}
              onClick={() => setTheme(t)}
              title={`${t} theme`}
            >
              {t === "light" ? "☀" : t === "dark" ? "🌙" : "📜"}
            </button>
          ))}
        </div>

        {vaultId && (
          <SearchPanel vaultId={vaultId} onSelect={openFile} />
        )}

        {vaultId && (
          <SnapshotsPanel vaultId={vaultId} />
        )}

        <div style={styles.treeScroll}>
          {manifestError ? (
            <p style={styles.sidebarError}>{manifestError}</p>
          ) : !manifest ? (
            <p style={styles.sidebarMuted}>Loading…</p>
          ) : treeNodes.length === 0 ? (
            <p style={styles.sidebarMuted}>This vault is empty.</p>
          ) : (
            <FolderTree
              nodes={treeNodes}
              selectedPath={selectedPath}
              onSelect={openFile}
              onRename={openRenameModal}
              onDelete={openDeleteModal}
            />
          )}
        </div>
      </aside>

      {/* Content pane */}
      <main style={styles.content}>
        <FileView
          view={fileView}
          vaultId={vaultId ?? ""}
          vaultPaths={manifest ? Object.values(manifest.entries).map((e) => e.path) : []}
          onEdit={(path, content) =>
            setFileView({ kind: "editing", path, content, saving: false })
          }
          onSave={handleSaveEdit}
          onCancelEdit={(path, content) =>
            setFileView({ kind: "text", path, content, contentType: "text/markdown" })
          }
          onRename={openRenameModal}
          onDelete={openDeleteModal}
          onOpenFile={openFile}
          onCreateNote={(path) => {
            setModal({ kind: "newNote", value: path, error: null });
          }}
        />
      </main>

      {/* Modals */}
      {modal.kind === "newNote" && (
        <ModalOverlay onClose={() => setModal({ kind: "none" })}>
          <ModalBox title="New note">
            <input
              style={styles.modalInput}
              autoFocus
              placeholder="path/to/note.md"
              value={modal.value}
              onChange={(e) => setModal({ ...modal, value: e.target.value, error: null })}
              onKeyDown={(e) => e.key === "Enter" && handleCreateNote()}
            />
            {modal.error && <p style={styles.modalError}>{modal.error}</p>}
            <div style={styles.modalActions}>
              <button style={styles.btnSecondary} onClick={() => setModal({ kind: "none" })}>
                Cancel
              </button>
              <button style={styles.btnPrimary} onClick={handleCreateNote}>
                Create
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}

      {modal.kind === "rename" && (
        <ModalOverlay onClose={() => setModal({ kind: "none" })}>
          <ModalBox title="Rename / move">
            <input
              style={styles.modalInput}
              autoFocus
              value={modal.value}
              onChange={(e) => setModal({ ...modal, value: e.target.value, error: null })}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
            />
            {modal.error && <p style={styles.modalError}>{modal.error}</p>}
            <div style={styles.modalActions}>
              <button style={styles.btnSecondary} onClick={() => setModal({ kind: "none" })}>
                Cancel
              </button>
              <button style={styles.btnPrimary} onClick={handleRename}>
                Rename
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}

      {modal.kind === "deleteConfirm" && (
        <ModalOverlay onClose={() => setModal({ kind: "none" })}>
          <ModalBox title="Delete file">
            <p style={{ margin: "0 0 1rem", color: "#1a1a1a" }}>
              Delete <strong>{modal.path}</strong>?
            </p>
            <div style={styles.modalActions}>
              <button style={styles.btnSecondary} onClick={() => setModal({ kind: "none" })}>
                Cancel
              </button>
              <button style={styles.btnDanger} onClick={handleDelete}>
                Delete
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}
    </div>
  );
}

// ── File viewer ───────────────────────────────────────────────────────────────

interface FileViewProps {
  view: FileViewState;
  vaultId: string;
  vaultPaths: string[];
  onEdit: (path: string, content: string) => void;
  onSave: (path: string, content: string) => void;
  onCancelEdit: (path: string, content: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCreateNote: (path: string) => void;
}

function isMarkdown(contentType: string, path: string): boolean {
  return (
    contentType === "text/markdown" ||
    path.toLowerCase().endsWith(".md")
  );
}

function FileView({ view, vaultId, vaultPaths, onEdit, onSave, onCancelEdit, onRename, onDelete, onOpenFile, onCreateNote }: FileViewProps) {
  if (view.kind === "idle") {
    return (
      <div style={styles.placeholder}>
        <p style={styles.placeholderText}>Select a file to preview it.</p>
      </div>
    );
  }

  if (view.kind === "loading") {
    return (
      <div style={styles.placeholder}>
        <p style={styles.placeholderText}>Loading…</p>
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <div style={styles.placeholder}>
        <p style={{ color: "#c0392b" }}>{view.message}</p>
      </div>
    );
  }

  if (view.kind === "editing") {
    return (
      <div style={styles.editorPane}>
        <div style={styles.fileHeader}>
          <span>{view.path}</span>
          <div style={styles.fileActions}>
            <button
              style={styles.btnPrimary}
              disabled={view.saving}
              onClick={() => onSave(view.path, view.content)}
            >
              {view.saving ? "Saving…" : "Save"}
            </button>
            <button
              style={styles.btnSecondary}
              disabled={view.saving}
              onClick={() => onCancelEdit(view.path, view.content)}
            >
              Cancel
            </button>
          </div>
        </div>
        <textarea
          style={styles.editor}
          value={view.content}
          onChange={(e) => {
            // propagate content change upward via a synthetic "editing" state update
            // We do a trick: write directly to the DOM then let React re-render
            const el = e.target;
            const val = el.value;
            // Re-use the onEdit callback to push fresh content
            onEdit(view.path, val);
          }}
          spellCheck={false}
        />
      </div>
    );
  }

  if (view.kind === "text") {
    const isMd = isMarkdown(view.contentType, view.path);
    return (
      <div style={styles.textPane}>
        <div style={styles.fileHeader}>
          <span>{view.path}</span>
          <div style={styles.fileActions}>
            <button style={styles.btnSecondary} onClick={() => onEdit(view.path, view.content)}>
              Edit
            </button>
            <button style={styles.btnSecondary} onClick={() => onRename(view.path)}>
              Rename
            </button>
            <button style={styles.btnDangerSm} onClick={() => onDelete(view.path)}>
              Delete
            </button>
          </div>
        </div>
        {isMd ? (
          <div style={styles.markdownScroll}>
            <MarkdownView
              source={view.content}
              vaultId={vaultId}
              vaultPaths={vaultPaths}
              onCreateNote={onCreateNote}
              onNavigate={onOpenFile}
            />
            <BacklinksPanel
              vaultId={vaultId}
              path={view.path}
              onNavigate={onOpenFile}
            />
          </div>
        ) : (
          <pre style={styles.pre}>{view.content}</pre>
        )}
      </div>
    );
  }

  if (view.kind === "image") {
    return (
      <div style={styles.imagePane}>
        <div style={styles.fileHeader}>
          <span>{view.path}</span>
          <div style={styles.fileActions}>
            <button style={styles.btnSecondary} onClick={() => onRename(view.path)}>
              Rename
            </button>
            <button style={styles.btnDangerSm} onClick={() => onDelete(view.path)}>
              Delete
            </button>
          </div>
        </div>
        <img
          src={api.fileUrl(vaultId, view.path)}
          alt={view.path}
          style={styles.image}
        />
      </div>
    );
  }

  if (view.kind === "binary") {
    return (
      <div style={styles.placeholder}>
        <div style={styles.fileHeader}>
          <span>{view.path}</span>
          <div style={styles.fileActions}>
            <button style={styles.btnSecondary} onClick={() => onRename(view.path)}>
              Rename
            </button>
            <button style={styles.btnDangerSm} onClick={() => onDelete(view.path)}>
              Delete
            </button>
          </div>
        </div>
        <p style={styles.placeholderText}>
          {view.contentType} · {formatBytes(view.size)}
        </p>
        <a
          href={api.fileUrl(vaultId, view.path)}
          download={view.path.split("/").pop()}
          style={styles.downloadLink}
        >
          Download
        </a>
      </div>
    );
  }

  return null;
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function ModalOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function ModalBox({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.modalBox}>
      <h3 style={styles.modalTitle}>{title}</h3>
      {children}
    </div>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
    background: "#ffffff",
  },
  sidebar: {
    width: 260,
    flexShrink: 0,
    borderRight: "1px solid #e0e0e0",
    display: "flex",
    flexDirection: "column",
    background: "#fafafa",
  },
  sidebarHeader: {
    padding: "0.85rem 0.75rem 0.6rem",
    borderBottom: "1px solid #e0e0e0",
  },
  backLink: {
    display: "block",
    fontSize: "0.8rem",
    color: "#6b6b6b",
    marginBottom: "0.3rem",
    textDecoration: "none",
  },
  devicesLink: {
    fontSize: "0.75rem",
    color: "#7c5cbf",
    textDecoration: "none",
    marginBottom: "0.3rem",
  },
  vaultName: {
    fontWeight: 700,
    fontSize: "0.95rem",
    color: "#1a1a1a",
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sidebarActions: {
    display: "flex",
    gap: "0.4rem",
    padding: "0.5rem 0.6rem",
    borderBottom: "1px solid #e0e0e0",
  },
  actionBtn: {
    flex: 1,
    padding: "0.35rem 0.5rem",
    background: "#7c5cbf",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  themeRow: {
    display: "flex",
    padding: "0.35rem 0.6rem",
    borderBottom: "1px solid #e0e0e0",
    gap: "0.3rem",
  },
  themeBtn: {
    flex: 1,
    background: "none",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    padding: "0.25rem",
    cursor: "pointer",
    fontSize: "0.9rem",
    lineHeight: 1,
  },
  themeBtnActive: {
    background: "#ede8f8",
    borderColor: "#7c5cbf",
  },
  treeScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "0.5rem 0",
  },
  markdownScroll: {
    flex: 1,
    overflowY: "auto",
  },
  sidebarMuted: {
    color: "#6b6b6b",
    fontSize: "0.85rem",
    padding: "0.5rem 0.75rem",
    margin: 0,
  },
  sidebarError: {
    color: "#c0392b",
    fontSize: "0.85rem",
    padding: "0.5rem 0.75rem",
    margin: 0,
  },
  content: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
  },
  placeholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: "0.75rem",
    flex: 1,
  },
  placeholderText: {
    color: "#6b6b6b",
    margin: 0,
  },
  fileHeader: {
    padding: "0.5rem 1rem",
    borderBottom: "1px solid #e0e0e0",
    fontSize: "0.8rem",
    color: "#6b6b6b",
    fontFamily: "var(--font-mono)",
    background: "#fafafa",
    position: "sticky",
    top: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  fileActions: {
    display: "flex",
    gap: "0.4rem",
    flexShrink: 0,
  },
  textPane: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
  },
  editorPane: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    height: "100%",
  },
  editor: {
    flex: 1,
    resize: "none",
    border: "none",
    outline: "none",
    padding: "1.25rem 1.5rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.875rem",
    lineHeight: 1.6,
    background: "#fff",
    color: "#1a1a1a",
  },
  pre: {
    margin: 0,
    padding: "1.25rem 1.5rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.875rem",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
    flex: 1,
  },
  imagePane: {
    display: "flex",
    flexDirection: "column",
  },
  image: {
    maxWidth: "100%",
    display: "block",
    margin: "1.5rem auto",
    padding: "0 1.5rem",
  },
  downloadLink: {
    padding: "0.55rem 1.25rem",
    background: "#7c5cbf",
    color: "#ffffff",
    borderRadius: 6,
    fontSize: "0.9rem",
    textDecoration: "none",
    fontWeight: 600,
  },
  // Modal
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modalBox: {
    background: "#fff",
    borderRadius: 8,
    padding: "1.5rem",
    minWidth: 340,
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
  },
  modalTitle: {
    margin: "0 0 1rem",
    fontSize: "1rem",
    fontWeight: 700,
  },
  modalInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "0.5rem 0.75rem",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontSize: "0.9rem",
    fontFamily: "var(--font-mono)",
    marginBottom: "0.5rem",
  },
  modalError: {
    color: "#c0392b",
    fontSize: "0.85rem",
    margin: "0 0 0.75rem",
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    marginTop: "0.75rem",
  },
  // Buttons
  btnPrimary: {
    padding: "0.4rem 0.9rem",
    background: "#7c5cbf",
    color: "#fff",
    border: "none",
    borderRadius: 5,
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnSecondary: {
    padding: "0.4rem 0.9rem",
    background: "none",
    color: "#6b6b6b",
    border: "1px solid #e0e0e0",
    borderRadius: 5,
    fontSize: "0.85rem",
    cursor: "pointer",
  },
  btnDanger: {
    padding: "0.4rem 0.9rem",
    background: "#c0392b",
    color: "#fff",
    border: "none",
    borderRadius: 5,
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDangerSm: {
    padding: "0.4rem 0.9rem",
    background: "none",
    color: "#c0392b",
    border: "1px solid #e0dede",
    borderRadius: 5,
    fontSize: "0.85rem",
    cursor: "pointer",
  },
};
