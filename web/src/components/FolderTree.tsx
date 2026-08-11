import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManifestEntry } from "../api";
import {
  CaretRight,
  Folder as FolderIcon,
  FolderOpen,
  FileText,
  FileImage,
  FilePdf,
  File as FileIcon,
  PencilSimple,
  Trash,
  ArrowSquareOut,
  FilePlus,
  FolderPlus,
} from "@phosphor-icons/react";

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

const HIDDEN_NAMES = new Set([".keep", ".gitkeep"]);

export function buildTree(entries: ManifestEntry[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const leaf = parts[parts.length - 1];
    // Keep folder structure from placeholder files, but hide the placeholders themselves.
    const hideLeaf = HIDDEN_NAMES.has(leaf);

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

    if (!hideLeaf) {
      current.children.push({ type: "file", name: leaf, path: entry.path, entry });
    }
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

// ── Flattening (for ARIA tree + roving tabindex) ────────────────────────────────

interface FlatRow {
  node: TreeNode;
  depth: number;
  parentPath: string | null;
}

function flatten(
  nodes: TreeNode[],
  open: Set<string>,
  depth: number,
  parentPath: string | null,
  out: FlatRow[]
): void {
  for (const node of nodes) {
    out.push({ node, depth, parentPath });
    if (node.type === "folder" && open.has(node.path)) {
      flatten(node.children, open, depth + 1, node.path, out);
    }
  }
}

function initialOpen(nodes: TreeNode[]): Set<string> {
  const set = new Set<string>();
  const walk = (ns: TreeNode[], depth: number) => {
    for (const n of ns) {
      if (n.type === "folder") {
        if (depth < 2) set.add(n.path);
        walk(n.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return set;
}

// ── Icons ───────────────────────────────────────────────────────────────────--

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

function FileGlyph({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return <FileText size={22} weight="regular" className="shrink-0 text-accent-soft" />;
  if (IMAGE_EXTS.has(ext)) return <FileImage size={22} weight="regular" className="shrink-0 text-muted" />;
  if (ext === "pdf") return <FilePdf size={22} weight="regular" className="shrink-0 text-muted" />;
  return <FileIcon size={22} weight="regular" className="shrink-0 text-muted" />;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// ── Component ───────────────────────────────────────────────────────────────--

interface FolderTreeProps {
  nodes: TreeNode[];
  selectedPath: string | null;
  /** Path of the folder used as create target (may equal selectedPath for folders). */
  focusedFolder?: string | null;
  onSelect: (path: string) => void;
  onSelectFolder?: (path: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  onNewNote?: (parentFolder: string) => void;
  onNewFolder?: (parentFolder: string) => void;
  onMove?: (sourcePath: string, destFolder: string) => void;
  depth?: number;
}

interface MenuState {
  path: string;
  type: "file" | "folder" | "root";
  x: number;
  y: number;
}

export function FolderTree({
  nodes,
  selectedPath,
  onSelect,
  onSelectFolder,
  onRename,
  onDelete,
  onNewNote,
  onNewFolder,
  onMove,
}: FolderTreeProps) {
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(nodes));
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const typeaheadRef = useRef({ str: "", t: 0 });

  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    if (parts.length < 2) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [selectedPath]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(nodes, open, 0, null, out);
    return out;
  }, [nodes, open]);

  const visiblePaths = useMemo(() => new Set(rows.map((r) => r.node.path)), [rows]);

  const tabbablePath =
    focusedPath && visiblePaths.has(focusedPath)
      ? focusedPath
      : selectedPath && visiblePaths.has(selectedPath)
        ? selectedPath
        : rows[0]?.node.path ?? null;

  const registerRow = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  }, []);

  const focusRow = useCallback((path?: string | null) => {
    if (!path) return;
    setFocusedPath(path);
    requestAnimationFrame(() => rowRefs.current.get(path)?.focus());
  }, []);

  const toggleOpen = useCallback((path: string, force?: boolean) => {
    setOpen((prev) => {
      const next = new Set(prev);
      const willOpen = force ?? !next.has(path);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const typeahead = useCallback(
    (ch: string) => {
      const now = Date.now();
      const state = typeaheadRef.current;
      state.str = now - state.t > 600 ? ch : state.str + ch;
      state.t = now;
      const q = state.str.toLowerCase();
      const startIdx = rows.findIndex((r) => r.node.path === tabbablePath);
      for (let k = 1; k <= rows.length; k++) {
        const r = rows[(Math.max(startIdx, 0) + k) % rows.length];
        if (r.node.name.toLowerCase().startsWith(q)) {
          focusRow(r.node.path);
          break;
        }
      }
    },
    [rows, tabbablePath, focusRow]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentPath = tabbablePath;
    const idx = rows.findIndex((r) => r.node.path === currentPath);
    if (idx < 0) return;
    const row = rows[idx];
    const node = row.node;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (idx < rows.length - 1) focusRow(rows[idx + 1].node.path);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (idx > 0) focusRow(rows[idx - 1].node.path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (node.type === "folder") {
          if (!open.has(node.path)) toggleOpen(node.path, true);
          else if (rows[idx + 1] && rows[idx + 1].parentPath === node.path)
            focusRow(rows[idx + 1].node.path);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (node.type === "folder" && open.has(node.path)) toggleOpen(node.path, false);
        else if (row.parentPath) focusRow(row.parentPath);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (node.type === "folder") {
          toggleOpen(node.path);
          onSelectFolder?.(node.path);
        } else onSelect(node.path);
        break;
      case "Home":
        e.preventDefault();
        focusRow(rows[0]?.node.path);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows[rows.length - 1]?.node.path);
        break;
      case "F2":
        if (node.type === "file" && onRename) {
          e.preventDefault();
          onRename(node.path);
        }
        break;
      case "Delete":
      case "Backspace":
        if (node.type === "file" && onDelete) {
          e.preventDefault();
          onDelete(node.path);
        }
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          typeahead(e.key);
        }
    }
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const canDropOn = (destFolder: string, sourcePath: string) => {
    if (!sourcePath) return false;
    if (destFolder === sourcePath) return false;
    if (destFolder.startsWith(sourcePath + "/")) return false;
    if (parentDir(sourcePath) === destFolder) return false;
    return true;
  };

  const finishDrop = (destFolder: string) => {
    if (!dragging || !onMove) return;
    if (!canDropOn(destFolder, dragging)) return;
    onMove(dragging, destFolder);
  };

  const menuParent =
    menu?.type === "folder" ? menu.path : menu?.type === "file" ? parentDir(menu.path) : "";

  return (
    <div
      role="tree"
      aria-label="Vault files"
      className="select-none px-1 text-[13px] outline-none"
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        // Empty area → root context menu
        if ((e.target as HTMLElement).closest("[data-treepath]")) return;
        e.preventDefault();
        setMenu({ path: "", type: "root", x: e.clientX, y: e.clientY });
      }}
      onDragOver={(e) => {
        if (!dragging || !onMove) return;
        e.preventDefault();
        setDragOver("");
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        finishDrop("");
        setDragOver(null);
        setDragging(null);
      }}
    >
      {rows.map((row) => {
        const { node } = row;
        const isFolder = node.type === "folder";
        const isOpen = isFolder && open.has(node.path);
        const isSelected = node.path === selectedPath;
        const isTabbable = node.path === tabbablePath;
        const isDropTarget =
          dragOver === node.path || (isFolder && dragOver === node.path);

        return (
          <div
            key={node.path}
            ref={(el) => registerRow(node.path, el)}
            data-treepath={node.path}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isSelected}
            aria-expanded={isFolder ? isOpen : undefined}
            tabIndex={isTabbable ? 0 : -1}
            title={node.path}
            draggable={!!onMove && !isFolder}
            onDragStart={(e) => {
              if (isFolder || !onMove) return;
              e.dataTransfer.setData("text/plain", node.path);
              e.dataTransfer.effectAllowed = "move";
              setDragging(node.path);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDragOver(null);
            }}
            onDragOver={(e) => {
              if (!dragging || !onMove) return;
              const dest = isFolder ? node.path : parentDir(node.path);
              if (!canDropOn(dest, dragging)) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(dest);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const dest = isFolder ? node.path : parentDir(node.path);
              finishDrop(dest);
              setDragOver(null);
              setDragging(null);
            }}
            onClick={() => {
              setFocusedPath(node.path);
              if (isFolder) {
                toggleOpen(node.path);
                onSelectFolder?.(node.path);
              } else onSelect(node.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setFocusedPath(node.path);
              setMenu({ path: node.path, type: node.type, x: e.clientX, y: e.clientY });
            }}
            className={`group relative flex h-7 cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 outline-none transition-colors ${
              isSelected ? "text-ink" : "text-muted hover:bg-hover hover:text-ink"
            } ${dragging === node.path ? "opacity-40" : ""} ${
              isDropTarget && isFolder
                ? "ring-1 ring-inset ring-accent-soft/60 bg-accent/10"
                : ""
            }`}
            style={{
              paddingLeft: 6 + row.depth * 12,
              backgroundColor: isSelected
                ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                : undefined,
            }}
          >
            {Array.from({ length: row.depth }).map((_, i) => (
              <span
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-border"
                style={{ left: 6 + i * 12 + 7 }}
              />
            ))}

            {isFolder ? (
              <CaretRight
                size={12}
                weight="bold"
                className={`shrink-0 text-faint transition-transform duration-100 ${
                  isOpen ? "rotate-90" : ""
                }`}
              />
            ) : (
              <span className="w-3 shrink-0" aria-hidden />
            )}

            {isFolder ? (
              isOpen ? (
                <FolderOpen size={22} weight="fill" className="shrink-0 text-accent-soft/70" />
              ) : (
                <FolderIcon size={22} weight="fill" className="shrink-0 text-accent-soft/70" />
              )
            ) : (
              <FileGlyph name={node.name} />
            )}

            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </div>
        );
      })}

      {dragOver === "" && dragging && (
        <div className="mx-1 mt-1 rounded border border-dashed border-accent-soft/50 px-2 py-1 text-[11px] text-accent-soft">
          Move to vault root
        </div>
      )}

      {menu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            role="menu"
            className="absolute min-w-48 rounded-lg border border-border bg-elevated py-1 shadow-2xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 280),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {onNewNote && (
              <MenuItem
                icon={<FilePlus size={22} />}
                label="New note"
                onClick={() => {
                  onNewNote(menuParent);
                  setMenu(null);
                }}
              />
            )}
            {onNewFolder && (
              <MenuItem
                icon={<FolderPlus size={22} />}
                label="New folder"
                onClick={() => {
                  onNewFolder(menuParent);
                  setMenu(null);
                }}
              />
            )}
            {(onNewNote || onNewFolder) && menu.type !== "root" && <MenuSep />}
            {menu.type === "file" && (
              <MenuItem
                icon={<ArrowSquareOut size={22} />}
                label="Open"
                onClick={() => {
                  onSelect(menu.path);
                  setMenu(null);
                }}
              />
            )}
            {menu.type === "folder" && (
              <MenuItem
                icon={open.has(menu.path) ? <FolderOpen size={22} /> : <FolderIcon size={22} />}
                label={open.has(menu.path) ? "Collapse" : "Expand"}
                onClick={() => {
                  toggleOpen(menu.path);
                  setMenu(null);
                }}
              />
            )}
            {menu.type === "file" && onRename && (
              <MenuItem
                icon={<PencilSimple size={22} />}
                label="Rename"
                shortcut="F2"
                onClick={() => {
                  onRename(menu.path);
                  setMenu(null);
                }}
              />
            )}
            {menu.type === "file" && onDelete && (
              <>
                <MenuSep />
                <MenuItem
                  icon={<Trash size={22} />}
                  label="Delete"
                  danger
                  onClick={() => {
                    onDelete(menu.path);
                    setMenu(null);
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuSep() {
  return <div className="my-1 border-t border-border" role="separator" />;
}

function MenuItem({
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${
        danger ? "text-danger" : "text-ink"
      }`}
    >
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <span className="font-mono text-[11px] text-faint">{shortcut}</span>}
    </button>
  );
}

export { joinPath, parentDir };
