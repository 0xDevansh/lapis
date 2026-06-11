import React, { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../api";
import { FolderTree, buildTree } from "../components/FolderTree";

type FileViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "text"; content: string; path: string; contentType: string }
  | { kind: "image"; path: string; contentType: string }
  | { kind: "binary"; path: string; contentType: string; size: number }
  | { kind: "error"; message: string };

const TEXT_TYPES = ["text/", "application/json", "application/xml"];
const IMAGE_TYPES = ["image/"];

function isTextType(ct: string): boolean {
  return TEXT_TYPES.some((t) => ct.startsWith(t));
}
function isImageType(ct: string): boolean {
  return IMAGE_TYPES.some((t) => ct.startsWith(t));
}

export default function VaultBrowserPage() {
  const { id: vaultId } = useParams<{ id: string }>();
  const [vault, setVault] = useState<api.Vault | null>(null);
  const [manifest, setManifest] = useState<api.VaultManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileViewState>({ kind: "idle" });

  // Load vault metadata + manifest
  useEffect(() => {
    if (!vaultId) return;

    api.getVault(vaultId).then(setVault).catch(() => {});

    api
      .getManifest(vaultId)
      .then(setManifest)
      .catch((e: Error) => setManifestError(e.message));
  }, [vaultId]);

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

      // Binary fallback — show metadata only
      setFileView({
        kind: "binary",
        path,
        contentType: entry.contentType,
        size: entry.size,
      });
    },
    [vaultId, manifest]
  );

  const treeNodes =
    manifest ? buildTree(Object.values(manifest.entries)) : [];

  return (
    <div style={styles.shell}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <Link to="/" style={styles.backLink}>
            ← Vaults
          </Link>
          <span style={styles.vaultName}>{vault?.name ?? "…"}</span>
        </div>

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
            />
          )}
        </div>
      </aside>

      {/* Content pane */}
      <main style={styles.content}>
        <FileView view={fileView} vaultId={vaultId ?? ""} />
      </main>
    </div>
  );
}

// ── File viewer ───────────────────────────────────────────────────────────────

function FileView({
  view,
  vaultId,
}: {
  view: FileViewState;
  vaultId: string;
}) {
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

  if (view.kind === "text") {
    return (
      <div style={styles.textPane}>
        <div style={styles.fileHeader}>{view.path}</div>
        <pre style={styles.pre}>{view.content}</pre>
      </div>
    );
  }

  if (view.kind === "image") {
    return (
      <div style={styles.imagePane}>
        <div style={styles.fileHeader}>{view.path}</div>
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
        <div style={styles.fileHeader}>{view.path}</div>
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
  vaultName: {
    fontWeight: 700,
    fontSize: "0.95rem",
    color: "#1a1a1a",
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  treeScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "0.5rem 0",
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
  },
  placeholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: "0.75rem",
  },
  placeholderText: {
    color: "#6b6b6b",
    margin: 0,
  },
  fileHeader: {
    padding: "0.6rem 1.5rem",
    borderBottom: "1px solid #e0e0e0",
    fontSize: "0.8rem",
    color: "#6b6b6b",
    fontFamily: "var(--font-mono)",
    background: "#fafafa",
    position: "sticky",
    top: 0,
    zIndex: 1,
  },
  textPane: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
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
};
