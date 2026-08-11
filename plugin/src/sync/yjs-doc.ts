import * as Y from "yjs";

export type FileKind = "text" | "binary";

export interface VaultMaps {
  docs: Y.Map<Y.Text>;
  bin: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<Y.Map<unknown>>;
  paths: Y.Map<string>;
}

export function getVaultMaps(doc: Y.Doc): VaultMaps {
  return {
    docs: doc.getMap("docs") as Y.Map<Y.Text>,
    bin: doc.getMap("bin") as Y.Map<Y.Map<unknown>>,
    meta: doc.getMap("meta") as Y.Map<Y.Map<unknown>>,
    paths: doc.getMap("paths") as Y.Map<string>,
  };
}

export function newFileId(): string {
  return crypto.randomUUID();
}

export function lowerPath(path: string): string {
  return path.toLowerCase();
}

function metaString(meta: Y.Map<unknown>, key: string): string | null {
  const v = meta.get(key);
  return typeof v === "string" ? v : null;
}

function isDeleted(meta: Y.Map<unknown>): boolean {
  return meta.has("deletedAt") && meta.get("deletedAt") != null;
}

export function listActiveFiles(doc: Y.Doc): Array<{ fileId: string; path: string; kind: FileKind; contentType: string }> {
  const { meta } = getVaultMaps(doc);
  const out: Array<{ fileId: string; path: string; kind: FileKind; contentType: string }> = [];
  meta.forEach((entry, fileId) => {
    if (!(entry instanceof Y.Map) || isDeleted(entry)) return;
    const path = metaString(entry, "path");
    const kind = metaString(entry, "kind") as FileKind | null;
    const contentType = metaString(entry, "contentType");
    if (!path || (kind !== "text" && kind !== "binary") || contentType == null) return;
    out.push({ fileId, path, kind, contentType });
  });
  return out;
}

export function getTextContent(doc: Y.Doc, fileId: string): string | null {
  const text = getVaultMaps(doc).docs.get(fileId);
  return text instanceof Y.Text ? text.toString() : null;
}

export function ensureText(doc: Y.Doc, fileId: string): Y.Text {
  const { docs } = getVaultMaps(doc);
  let text = docs.get(fileId);
  if (!(text instanceof Y.Text)) {
    text = new Y.Text();
    docs.set(fileId, text);
  }
  return text;
}

function setPathIndex(paths: Y.Map<string>, fileId: string, newPath: string, oldPath?: string | null): void {
  if (oldPath) {
    const oldLower = lowerPath(oldPath);
    if (paths.get(oldLower) === fileId) paths.delete(oldLower);
  }
  paths.set(lowerPath(newPath), fileId);
}

export function upsertTextMeta(
  doc: Y.Doc,
  opts: { fileId: string; path: string; contentType: string }
): void {
  doc.transact(() => {
    const { meta, paths } = getVaultMaps(doc);
    const existing = meta.get(opts.fileId);
    const oldPath = existing instanceof Y.Map ? metaString(existing, "path") : null;
    const entry = existing instanceof Y.Map ? existing : new Y.Map<unknown>();
    entry.set("path", opts.path);
    entry.set("kind", "text");
    entry.set("contentType", opts.contentType);
    entry.set("updatedAt", new Date().toISOString());
    if (entry.has("deletedAt")) entry.delete("deletedAt");
    if (!(existing instanceof Y.Map)) meta.set(opts.fileId, entry);
    setPathIndex(paths, opts.fileId, opts.path, oldPath);
  });
}

export function renameFile(doc: Y.Doc, fileId: string, newPath: string): void {
  doc.transact(() => {
    const { meta, paths } = getVaultMaps(doc);
    const entry = meta.get(fileId);
    if (!(entry instanceof Y.Map)) throw new Error(`Unknown fileId: ${fileId}`);
    const oldPath = metaString(entry, "path");
    entry.set("path", newPath);
    entry.set("updatedAt", new Date().toISOString());
    setPathIndex(paths, fileId, newPath, oldPath);
  });
}

export function softDeleteFile(doc: Y.Doc, fileId: string): void {
  doc.transact(() => {
    const { meta, paths } = getVaultMaps(doc);
    const entry = meta.get(fileId);
    if (!(entry instanceof Y.Map)) throw new Error(`Unknown fileId: ${fileId}`);
    const path = metaString(entry, "path");
    entry.set("deletedAt", new Date().toISOString());
    entry.set("updatedAt", new Date().toISOString());
    if (path) {
      const key = lowerPath(path);
      if (paths.get(key) === fileId) paths.delete(key);
    }
  });
}

export function setBinaryMeta(
  doc: Y.Doc,
  opts: {
    fileId?: string;
    path: string;
    r2Key: string;
    hash: string;
    size: number;
    contentType: string;
  }
): string {
  const fileId = opts.fileId ?? newFileId();
  const now = new Date().toISOString();
  doc.transact(() => {
    const { bin, meta, paths } = getVaultMaps(doc);
    const existingMeta = meta.get(fileId);
    const oldPath = existingMeta instanceof Y.Map ? metaString(existingMeta, "path") : null;

    const binEntry = bin.get(fileId) instanceof Y.Map ? (bin.get(fileId) as Y.Map<unknown>) : new Y.Map<unknown>();
    binEntry.set("r2Key", opts.r2Key);
    binEntry.set("hash", opts.hash);
    binEntry.set("size", opts.size);
    binEntry.set("contentType", opts.contentType);
    if (!(bin.get(fileId) instanceof Y.Map)) bin.set(fileId, binEntry);

    const entry = existingMeta instanceof Y.Map ? existingMeta : new Y.Map<unknown>();
    entry.set("path", opts.path);
    entry.set("kind", "binary");
    entry.set("contentType", opts.contentType);
    entry.set("updatedAt", now);
    if (entry.has("deletedAt")) entry.delete("deletedAt");
    if (!(existingMeta instanceof Y.Map)) meta.set(fileId, entry);

    setPathIndex(paths, fileId, opts.path, oldPath);
  });
  return fileId;
}

export function fileIdForPath(doc: Y.Doc, path: string): string | undefined {
  return getVaultMaps(doc).paths.get(lowerPath(path));
}
