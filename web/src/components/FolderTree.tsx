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
  depth?: number;
}

export function FolderTree({
  nodes,
  selectedPath,
  onSelect,
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
            depth={depth}
          />
        ) : (
          <FileItem
            key={node.path}
            file={node}
            selected={selectedPath === node.path}
            onSelect={() => onSelect(node.path)}
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
  depth,
}: {
  folder: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
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
}: {
  file: TreeFile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li style={styles.item}>
      <button
        style={{
          ...styles.fileButton,
          ...(selected ? styles.fileButtonSelected : {}),
        }}
        onClick={onSelect}
        title={file.path}
      >
        <span style={styles.fileIcon}>{fileIcon(file.name)}</span>
        <span style={styles.fileName}>{file.name}</span>
      </button>
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
  fileButton: {
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
  fileButtonSelected: {
    background: "#ede8f8",
    color: "#7c5cbf",
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
