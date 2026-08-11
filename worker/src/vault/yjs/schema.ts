import * as Y from "yjs";

export type FileKind = "text" | "binary";

export interface VaultMaps {
  docs: Y.Map<Y.Text>;
  bin: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<Y.Map<unknown>>;
  paths: Y.Map<string>;
}

export interface ActiveFile {
  fileId: string;
  path: string;
  kind: FileKind;
  contentType: string;
}

export interface ManifestFile {
  path: string;
  size: number;
  contentType: string;
  kind: FileKind;
  fileId: string;
  r2Key?: string;
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

export function listActiveFiles(doc: Y.Doc): ActiveFile[] {
  const { meta } = getVaultMaps(doc);
  const out: ActiveFile[] = [];
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

function replaceText(text: Y.Text, content: string): void {
  const len = text.length;
  if (len > 0) text.delete(0, len);
  if (content.length > 0) text.insert(0, content);
}

function setPathIndex(
  paths: Y.Map<string>,
  fileId: string,
  newPath: string,
  oldPath?: string | null
): void {
  if (oldPath) {
    const oldLower = lowerPath(oldPath);
    if (paths.get(oldLower) === fileId) paths.delete(oldLower);
  }
  paths.set(lowerPath(newPath), fileId);
}

export function setTextFile(
  doc: Y.Doc,
  opts: { fileId?: string; path: string; content: string; contentType: string }
): string {
  const fileId = opts.fileId ?? newFileId();
  const now = new Date().toISOString();

  doc.transact(() => {
    const { docs, meta, paths } = getVaultMaps(doc);
    const existing = meta.get(fileId);
    const oldPath = existing instanceof Y.Map ? metaString(existing, "path") : null;
    // Content edits must not overwrite path (rename goes through renameFile).
    const path = oldPath ?? opts.path;

    let text = docs.get(fileId);
    if (!(text instanceof Y.Text)) {
      text = new Y.Text();
      docs.set(fileId, text);
    }
    replaceText(text, opts.content);

    const entry = existing instanceof Y.Map ? existing : new Y.Map<unknown>();
    entry.set("path", path);
    entry.set("kind", "text");
    entry.set("contentType", opts.contentType);
    entry.set("updatedAt", now);
    if (entry.has("deletedAt")) entry.delete("deletedAt");
    if (!(existing instanceof Y.Map)) meta.set(fileId, entry);

    setPathIndex(paths, fileId, path, oldPath);
  });

  return fileId;
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

export function materializeManifest(doc: Y.Doc): ManifestFile[] {
  const { docs, bin } = getVaultMaps(doc);
  const encoder = new TextEncoder();
  const out: ManifestFile[] = [];

  for (const { fileId, path, kind, contentType } of listActiveFiles(doc)) {
    if (kind === "text") {
      const text = docs.get(fileId);
      const content = text instanceof Y.Text ? text.toString() : "";
      out.push({
        fileId,
        path,
        kind,
        contentType,
        size: encoder.encode(content).byteLength,
      });
      continue;
    }

    const binEntry = bin.get(fileId);
    const size = binEntry instanceof Y.Map && typeof binEntry.get("size") === "number" ? (binEntry.get("size") as number) : 0;
    const r2Key = binEntry instanceof Y.Map && typeof binEntry.get("r2Key") === "string" ? (binEntry.get("r2Key") as string) : undefined;
    out.push({ fileId, path, kind, contentType, size, ...(r2Key !== undefined ? { r2Key } : {}) });
  }

  return out;
}
