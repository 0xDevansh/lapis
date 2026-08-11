/**
 * Pure reconcile planner: compare last-known index to a disk snapshot.
 * Detects renames via content-hash matching when Obsidian rename events
 * were missed (app closed / external edits).
 */

export interface DiskFileSnap {
  path: string;
  hash: string;
  kind: "text" | "binary";
}

export interface FsIndexState {
  version: 1;
  vaultId: string;
  /** lower(path) → fileId */
  pathToId: Record<string, string>;
  /** fileId → content hash */
  idToHash: Record<string, string>;
  /** fileId → canonical path */
  idToPath: Record<string, string>;
}

export type ReconcileOp =
  | { op: "create"; path: string; hash: string; kind: "text" | "binary" }
  | { op: "modify"; fileId: string; path: string; hash: string; kind: "text" | "binary" }
  | { op: "rename"; fileId: string; oldPath: string; newPath: string; hash: string }
  | { op: "delete"; fileId: string; path: string };

export function emptyFsIndex(vaultId: string): FsIndexState {
  return { version: 1, vaultId, pathToId: {}, idToHash: {}, idToPath: {} };
}

export function isValidFsIndex(value: unknown, vaultId: string): value is FsIndexState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<FsIndexState>;
  return (
    v.version === 1 &&
    v.vaultId === vaultId &&
    typeof v.pathToId === "object" &&
    typeof v.idToHash === "object" &&
    typeof v.idToPath === "object"
  );
}

function lower(path: string): string {
  return path.toLowerCase();
}

/**
 * Plan disk → CRDT ops from a prior index.
 * Hash-unique deleted↔created pairs become renames; otherwise delete+create.
 */
export function planReconcile(index: FsIndexState, disk: DiskFileSnap[]): ReconcileOp[] {
  const diskByPath = new Map(disk.map((f) => [lower(f.path), f]));
  const knownPaths = new Set(Object.keys(index.pathToId));

  const missing: Array<{ path: string; fileId: string; hash: string }> = [];
  const created: DiskFileSnap[] = [];
  const ops: ReconcileOp[] = [];

  for (const [lp, fileId] of Object.entries(index.pathToId)) {
    const snap = diskByPath.get(lp);
    const knownHash = index.idToHash[fileId] ?? "";
    const knownPath = index.idToPath[fileId] ?? lp;
    if (!snap) {
      missing.push({ path: knownPath, fileId, hash: knownHash });
      continue;
    }
    if (snap.hash !== knownHash) {
      ops.push({ op: "modify", fileId, path: snap.path, hash: snap.hash, kind: snap.kind });
    }
  }

  for (const snap of disk) {
    if (!knownPaths.has(lower(snap.path))) {
      created.push(snap);
    }
  }

  // Hash-match moves: unmatched deleted ↔ unmatched created with same hash
  const usedCreated = new Set<string>();
  const hashToCreated = new Map<string, DiskFileSnap[]>();
  for (const snap of created) {
    const list = hashToCreated.get(snap.hash) ?? [];
    list.push(snap);
    hashToCreated.set(snap.hash, list);
  }

  for (const gone of missing) {
    const candidates = (hashToCreated.get(gone.hash) ?? []).filter(
      (c) => !usedCreated.has(lower(c.path)) && c.hash.length > 0
    );
    if (candidates.length === 1) {
      const dest = candidates[0];
      usedCreated.add(lower(dest.path));
      ops.push({
        op: "rename",
        fileId: gone.fileId,
        oldPath: gone.path,
        newPath: dest.path,
        hash: dest.hash,
      });
    } else {
      ops.push({ op: "delete", fileId: gone.fileId, path: gone.path });
    }
  }

  for (const snap of created) {
    if (usedCreated.has(lower(snap.path))) continue;
    ops.push({ op: "create", path: snap.path, hash: snap.hash, kind: snap.kind });
  }

  return ops;
}

export function applyOpToIndex(index: FsIndexState, op: ReconcileOp, fileId?: string): void {
  const id = fileId ?? ("fileId" in op ? op.fileId : undefined);
  if (op.op === "create" && id) {
    index.pathToId[lower(op.path)] = id;
    index.idToHash[id] = op.hash;
    index.idToPath[id] = op.path;
  } else if (op.op === "modify" && id) {
    index.idToHash[id] = op.hash;
    index.idToPath[id] = op.path;
    index.pathToId[lower(op.path)] = id;
  } else if (op.op === "rename" && id) {
    delete index.pathToId[lower(op.oldPath)];
    index.pathToId[lower(op.newPath)] = id;
    index.idToPath[id] = op.newPath;
    index.idToHash[id] = op.hash;
  } else if (op.op === "delete" && id) {
    delete index.pathToId[lower(op.path)];
    delete index.idToHash[id];
    delete index.idToPath[id];
  }
}
