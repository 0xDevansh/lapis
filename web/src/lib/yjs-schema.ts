/** Browser Yjs vault schema — maps + mutations (mirrors worker/plugin). */
import * as Y from "yjs";

export type FileKind = "text" | "binary";

export interface VaultMaps {
  docs: Y.Map<Y.Text>;
  bin: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<Y.Map<unknown>>;
  paths: Y.Map<string>;
}

export interface ActivePath {
  fileId: string;
  path: string;
  kind: FileKind;
  contentType: string;
}

export function getVaultMaps(doc: Y.Doc): VaultMaps {
  return {
    docs: doc.getMap("docs") as Y.Map<Y.Text>,
    bin: doc.getMap("bin") as Y.Map<Y.Map<unknown>>,
    meta: doc.getMap("meta") as Y.Map<Y.Map<unknown>>,
    paths: doc.getMap("paths") as Y.Map<string>,
  };
}

export function lowerPath(path: string): string {
  return path.toLowerCase();
}

export function newFileId(): string {
  return crypto.randomUUID();
}

function metaString(meta: Y.Map<unknown>, key: string): string | null {
  const v = meta.get(key);
  return typeof v === "string" ? v : null;
}

function setPathIndex(paths: Y.Map<string>, fileId: string, newPath: string, oldPath?: string | null): void {
  if (oldPath) {
    const oldLower = lowerPath(oldPath);
    if (paths.get(oldLower) === fileId) paths.delete(oldLower);
  }
  paths.set(lowerPath(newPath), fileId);
}

export function listActivePaths(doc: Y.Doc): ActivePath[] {
  const { meta } = getVaultMaps(doc);
  const out: ActivePath[] = [];
  meta.forEach((entry, fileId) => {
    if (!(entry instanceof Y.Map)) return;
    if (entry.get("deletedAt") != null) return;
    const path = metaString(entry, "path");
    const kind = metaString(entry, "kind") as FileKind | null;
    const contentType = metaString(entry, "contentType") ?? "text/plain";
    if (!path || (kind !== "text" && kind !== "binary")) return;
    out.push({ fileId, path, kind, contentType });
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function fileIdForPath(doc: Y.Doc, path: string): string | undefined {
  return getVaultMaps(doc).paths.get(lowerPath(path));
}

export function getText(doc: Y.Doc, fileId: string): string {
  const t = getVaultMaps(doc).docs.get(fileId);
  return t instanceof Y.Text ? t.toString() : "";
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

/** Compact mid-string edit into Y.Text (prefix/suffix trim). */
export function applyTextDelta(text: Y.Text, next: string): void {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev -= 1;
    endNext -= 1;
  }
  const deleteLen = endPrev - start;
  if (deleteLen > 0) text.delete(start, deleteLen);
  const insert = next.slice(start, endNext);
  if (insert.length > 0) text.insert(start, insert);
}

export function createTextFile(doc: Y.Doc, path: string, content: string, contentType = "text/markdown"): string {
  const fileId = newFileId();
  doc.transact(() => {
    const text = ensureText(doc, fileId);
    if (content) text.insert(0, content);
    const { meta, paths } = getVaultMaps(doc);
    const entry = new Y.Map<unknown>();
    entry.set("path", path);
    entry.set("kind", "text");
    entry.set("contentType", contentType);
    entry.set("updatedAt", new Date().toISOString());
    meta.set(fileId, entry);
    paths.set(lowerPath(path), fileId);
  });
  return fileId;
}

export function writeTextPath(doc: Y.Doc, path: string, content: string, contentType = "text/markdown"): string {
  const existing = fileIdForPath(doc, path);
  if (existing) {
    doc.transact(() => {
      const text = ensureText(doc, existing);
      applyTextDelta(text, content);
      const { meta } = getVaultMaps(doc);
      const entry = meta.get(existing);
      if (entry instanceof Y.Map) {
        entry.set("contentType", contentType);
        entry.set("updatedAt", new Date().toISOString());
        if (entry.has("deletedAt")) entry.delete("deletedAt");
      }
    });
    return existing;
  }
  return createTextFile(doc, path, content, contentType);
}

export function renamePath(doc: Y.Doc, oldPath: string, newPath: string): boolean {
  const fileId = fileIdForPath(doc, oldPath);
  if (!fileId) return false;
  doc.transact(() => {
    const { meta, paths } = getVaultMaps(doc);
    const entry = meta.get(fileId);
    if (!(entry instanceof Y.Map)) return;
    entry.set("path", newPath);
    entry.set("updatedAt", new Date().toISOString());
    setPathIndex(paths, fileId, newPath, oldPath);
  });
  return true;
}

export function softDeletePath(doc: Y.Doc, path: string): boolean {
  const fileId = fileIdForPath(doc, path);
  if (!fileId) return false;
  doc.transact(() => {
    const { meta, paths } = getVaultMaps(doc);
    const entry = meta.get(fileId);
    if (!(entry instanceof Y.Map)) return;
    entry.set("deletedAt", new Date().toISOString());
    entry.set("updatedAt", new Date().toISOString());
    const key = lowerPath(path);
    if (paths.get(key) === fileId) paths.delete(key);
  });
  return true;
}

export function setBinaryMeta(
  doc: Y.Doc,
  opts: { fileId?: string; path: string; r2Key: string; hash: string; size: number; contentType: string }
): string {
  const fileId = opts.fileId ?? newFileId();
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
    entry.set("updatedAt", new Date().toISOString());
    if (entry.has("deletedAt")) entry.delete("deletedAt");
    if (!(existingMeta instanceof Y.Map)) meta.set(fileId, entry);
    setPathIndex(paths, fileId, opts.path, oldPath);
  });
  return fileId;
}

/** FolderTree-compatible entries derived from Y.Doc (no REST). */
export function toManifestEntries(doc: Y.Doc): Array<{
  path: string;
  size: number;
  contentType: string;
  updatedAt: string;
  revision: number;
}> {
  const encoder = new TextEncoder();
  return listActivePaths(doc).map((f) => {
    const size =
      f.kind === "text" ? encoder.encode(getText(doc, f.fileId)).byteLength : 0;
    return {
      path: f.path,
      size,
      contentType: f.contentType,
      updatedAt: new Date().toISOString(),
      revision: 1,
    };
  });
}
