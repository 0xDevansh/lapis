import React, { useState } from "react";
import type { ManifestEntry } from "../api";

// ── Tree building ─────────────────────────────────────────────────────────────

interface TreeFile {
  type: "file";
  name: string;
  path: string;
  entry: ManifestEntry;
}

interface TreeFolder {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

type TreeNode = TreeFile | TreeFolder;

export function buildTree(entries: ManifestEntry[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join("/");
      let child = current.children.find(
        (n) => n.type === "folder" && n.name === folderName
      ) as TreeFolder | undefined;

      if (!child) {
        child = { type: "folder", name: folderName, path: folderPath, children: [] };
        current.children.push(child);
      }
      current = child;
    }

    const fileName = parts[parts.length - 1];
    current.children.push({ type: "file", name: fileName, path: entry.path, entry });
  }

  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.type === "folder") sortTree(node.children);
  }
}

// ── Components ────────────────────────────────────────────────────────────────

interface FolderTreeProps {
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  depth?: number;
}

export function FolderTree({
  nodes,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  depth = 0,
}: FolderTreeProps) {
  return (
    <ul style={{ ...styles.list, paddingLeft: depth === 0 ? 0 : "1rem" }}>
      {nodes.map((node) =>
        node.type === "folder" ? (
          <FolderItem
            key={node.path}
            folder={node}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
            depth={depth}
          />
        ) : (
          <FileItem
            key={node.path}
            file={node}
            selected={selectedPath === node.path}
            onSelect={() => onSelect(node.path)}
            onRename={onRename}
            onDelete={onDelete}
          />
        )
      )}
    </ul>
  );
}

function FolderItem({
  folder,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  depth,
}: {
  folder: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2); // auto-expand top two levels

  return (
    <li style={styles.item}>
      <button
        style={styles.folderButton}
        onClick={() => setOpen((o) => !o)}
        title={folder.path}
      >
        <span style={styles.folderIcon}>{open ? "▾" : "▸"}</span>
        <span style={styles.folderName}>{folder.name}</span>
      </button>
      {open && (
        <FolderTree
          nodes={folder.children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          depth={depth + 1}
        />
      )}
    </li>
  );
}

function FileItem({
  file,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  file: TreeFile;
  selected: boolean;
  onSelect: () => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <li
      style={styles.item}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          ...styles.fileRow,
          ...(selected ? styles.fileRowSelected : {}),
        }}
      >
        <button
          style={styles.fileButton}
          onClick={onSelect}
          title={file.path}
        >
          <span style={styles.fileIcon}>{fileIcon(file.name)}</span>
          <span style={styles.fileName}>{file.name}</span>
        </button>
        {(hovered || selected) && (onRename || onDelete) && (
          <div style={styles.fileItemActions}>
            {onRename && (
              <button
                style={styles.fileActionBtn}
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  onRename(file.path);
                }}
              >
                ✎
              </button>
            )}
            {onDelete && (
              <button
                style={{ ...styles.fileActionBtn, color: "#c0392b" }}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(file.path);
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "📄";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "🖼";
  if (["pdf"].includes(ext)) return "📋";
  return "📎";
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  item: {
    margin: 0,
    padding: 0,
  },
  folderButton: {
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    width: "100%",
    background: "none",
    border: "none",
    padding: "0.25rem 0.5rem",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.875rem",
    color: "#1a1a1a",
    borderRadius: 4,
  },
  folderIcon: {
    fontSize: "0.75rem",
    color: "#6b6b6b",
    width: 12,
    flexShrink: 0,
  },
  folderName: {
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileRow: {
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    overflow: "hidden",
  },
  fileRowSelected: {
    background: "#ede8f8",
  },
  fileButton: {
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    flex: 1,
    minWidth: 0,
    background: "none",
    border: "none",
    padding: "0.25rem 0.5rem",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.875rem",
    color: "#1a1a1a",
  },
  fileItemActions: {
    display: "flex",
    flexShrink: 0,
    paddingRight: "0.25rem",
  },
  fileActionBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0.15rem 0.3rem",
    fontSize: "0.8rem",
    color: "#6b6b6b",
    borderRadius: 3,
    lineHeight: 1,
  },
  fileIcon: {
    fontSize: "0.875rem",
    flexShrink: 0,
  },
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
