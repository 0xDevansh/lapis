import { Notice, TFile, type App } from "obsidian";
import * as Y from "yjs";
import { LapisClient } from "../net/client";
import type { LapisSettings } from "../types";
import { sha256Hex } from "./hash";
import { shouldSyncPath, lowerPath } from "./paths";
import {
  applyOpToIndex,
  emptyFsIndex,
  isValidFsIndex,
  planReconcile,
  type DiskFileSnap,
  type FsIndexState,
} from "./reconcile";
import { applyTextDelta } from "./text-delta";
import { PluginYjsClient, yjsWsUrl } from "./yjs-client";
import {
  ensureText,
  fileIdForPath,
  getTextContent,
  getVaultMaps,
  listActiveFiles,
  newFileId,
  renameFile,
  setBinaryMeta,
  softDeleteFile,
  upsertTextMeta,
} from "./yjs-doc";

const TEXT_EXTS = new Set([
  "md", "txt", "csv", "json", "html", "css", "js", "ts", "xml", "svg", "yml", "yaml", "toml", "canvas",
]);

function isTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

function contentTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    canvas: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    svg: "image/svg+xml",
  };
  return map[ext] ?? (isTextPath(path) ? "text/plain" : "application/octet-stream");
}

export interface YjsFsBridgeOptions {
  app: App;
  settings: LapisSettings;
  getIndex: () => FsIndexState | null;
  setIndex: (index: FsIndexState) => Promise<void>;
  getYjsState: () => Uint8Array | null;
  setYjsState: (state: Uint8Array) => Promise<void>;
  onStatus?: (s: "connected" | "disconnected" | "syncing" | "error") => void;
}

/**
 * Bridges Obsidian vault filesystem ↔ Lapis Y.Doc.
 * - Live: vault create/modify/delete/rename events
 * - Cold start / external edits: hash reconcile (moves by hash match)
 */
export class YjsFsBridge {
  private client: PluginYjsClient | null = null;
  private suppress = false;
  private remoteRename = new Set<string>();
  private remoteDelete = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly options: YjsFsBridgeOptions) {}

  get doc(): Y.Doc | null {
    return this.client?.doc ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { settings } = this.options;
    if (!settings.syncToken || !settings.vaultId) {
      throw new Error("Not connected");
    }

    this.options.onStatus?.("syncing");
    const yjs = new PluginYjsClient(
      yjsWsUrl(settings.serverUrl, settings.vaultId, settings.syncToken),
      (s) => this.options.onStatus?.(s === "connected" ? "connected" : s === "error" ? "error" : "disconnected")
    );

    const saved = this.options.getYjsState();
    if (saved && saved.byteLength > 0) {
      yjs.applyState(saved);
    }

    this.client = yjs;
    yjs.connect();

    // Let initial sync exchange land, then reconcile disk → doc
    await sleep(800);
    await this.reconcileFromDisk();
    this.observeRemote();
    this.schedulePersist();
    this.started = true;
    this.options.onStatus?.("connected");
  }

  stop(): void {
    this.started = false;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.materializeTimer) clearTimeout(this.materializeTimer);
    this.client?.destroy();
    this.client = null;
  }

  /** Obsidian watcher: create */
  async onLocalCreate(path: string): Promise<void> {
    if (this.suppress || !this.shouldSync(path) || !this.client) return;
    await this.pushPath(path);
  }

  /** Obsidian watcher: modify */
  async onLocalModify(path: string): Promise<void> {
    if (this.suppress || !this.shouldSync(path) || !this.client) return;
    await this.pushPath(path);
  }

  /** Obsidian watcher: rename (stable in-session event) */
  async onLocalRename(oldPath: string, newPath: string): Promise<void> {
    if (this.suppress || !this.client) return;
    if (this.consumeRemoteRename(newPath) || this.consumeRemoteRename(oldPath)) return;
    if (!this.shouldSync(newPath) && !this.shouldSync(oldPath)) return;

    const doc = this.client.doc;
    const index = this.ensureIndex();
    const fileId =
      index.pathToId[lowerPath(oldPath)] ??
      fileIdForPath(doc, oldPath) ??
      index.pathToId[lowerPath(newPath)];

    if (!fileId) {
      // Unknown — treat as create at new path
      if (this.shouldSync(newPath)) await this.pushPath(newPath);
      return;
    }

    renameFile(doc, fileId, newPath);
    delete index.pathToId[lowerPath(oldPath)];
    index.pathToId[lowerPath(newPath)] = fileId;
    index.idToPath[fileId] = newPath;
    await this.options.setIndex(index);
    this.schedulePersist();
  }

  /** Obsidian watcher: delete */
  async onLocalDelete(path: string): Promise<void> {
    if (this.suppress || !this.client) return;
    if (this.consumeRemoteDelete(path)) return;
    if (!this.shouldSync(path)) return;

    const doc = this.client.doc;
    const index = this.ensureIndex();
    const fileId = index.pathToId[lowerPath(path)] ?? fileIdForPath(doc, path);
    if (!fileId) return;

    softDeleteFile(doc, fileId);
    delete index.pathToId[lowerPath(path)];
    delete index.idToHash[fileId];
    delete index.idToPath[fileId];
    await this.options.setIndex(index);
    this.schedulePersist();
  }

  /**
   * Full disk scan reconcile — covers edits/moves while Obsidian was closed.
   * Renames without events are recovered by matching content hashes.
   */
  async reconcileFromDisk(): Promise<{ ops: number }> {
    if (!this.client) return { ops: 0 };
    const doc = this.client.doc;
    const index = this.ensureIndex();
    const snaps = await this.scanDisk();
    const plan = planReconcile(index, snaps);

    this.suppress = true;
    try {
      for (const op of plan) {
        if (op.op === "create") {
          const fileId = await this.writeLocalFileIntoDoc(op.path, op.kind);
          if (fileId) applyOpToIndex(index, op, fileId);
        } else if (op.op === "modify") {
          await this.writeLocalFileIntoDoc(op.path, op.kind, op.fileId);
          applyOpToIndex(index, op, op.fileId);
        } else if (op.op === "rename") {
          renameFile(doc, op.fileId, op.newPath);
          applyOpToIndex(index, op, op.fileId);
        } else if (op.op === "delete") {
          softDeleteFile(doc, op.fileId);
          applyOpToIndex(index, op, op.fileId);
        }
      }

      // Pull: materialize any Yjs files missing/outdated on disk
      await this.materializeDocToDisk();

      await this.options.setIndex(index);
      this.schedulePersist();
      return { ops: plan.length };
    } finally {
      this.suppress = false;
    }
  }

  private async pushPath(path: string): Promise<void> {
    if (!this.client) return;
    const kind = isTextPath(path) ? "text" : "binary";
    const index = this.ensureIndex();
    const existingId = index.pathToId[lowerPath(path)] ?? fileIdForPath(this.client.doc, path);
    const fileId = await this.writeLocalFileIntoDoc(path, kind, existingId);
    if (!fileId) return;
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const bytes = await this.options.app.vault.readBinary(file);
    const hash = await sha256Hex(bytes);
    index.pathToId[lowerPath(path)] = fileId;
    index.idToHash[fileId] = hash;
    index.idToPath[fileId] = path;
    await this.options.setIndex(index);
    this.schedulePersist();
  }

  private async writeLocalFileIntoDoc(
    path: string,
    kind: "text" | "binary",
    existingId?: string
  ): Promise<string | null> {
    if (!this.client) return null;
    const doc = this.client.doc;
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;

    const contentType = contentTypeFromPath(path);
    const bytes = await this.options.app.vault.readBinary(file);
    const hash = await sha256Hex(bytes);
    const fileId = existingId ?? newFileId();

    if (kind === "text") {
      const text = new TextDecoder().decode(bytes);
      const ytext = ensureText(doc, fileId);
      applyTextDelta(ytext, text);
      upsertTextMeta(doc, { fileId, path, contentType });
      return fileId;
    }

    const { settings } = this.options;
    const http = new LapisClient(settings.serverUrl);
    await http.putFile(settings.vaultId, path, bytes, contentType, settings.syncToken);
    setBinaryMeta(doc, {
      fileId,
      path,
      r2Key: `${settings.vaultId}/${path}`,
      hash,
      size: bytes.byteLength,
      contentType,
    });
    return fileId;
  }

  private observeRemote(): void {
    if (!this.client) return;
    const doc = this.client.doc;
    const { meta, docs } = getVaultMaps(doc);

    meta.observe((event) => {
      if (this.suppress) return;
      for (const [fileId, change] of event.keys) {
        if (change.action === "delete") continue;
        this.queueMaterialize(fileId);
      }
    });
    docs.observe((event) => {
      if (this.suppress) return;
      for (const [fileId] of event.keys) {
        this.queueMaterialize(fileId);
      }
    });
    // Deep path/deletedAt changes
    meta.observeDeep(() => {
      if (this.suppress) return;
      this.queueMaterializeAll();
    });
  }

  private queueMaterialize(fileId: string): void {
    void this.materializeFile(fileId);
  }

  private queueMaterializeAll(): void {
    if (this.materializeTimer) clearTimeout(this.materializeTimer);
    this.materializeTimer = setTimeout(() => {
      void this.materializeDocToDisk();
    }, 200);
  }

  private async materializeDocToDisk(): Promise<void> {
    if (!this.client) return;
    const doc = this.client.doc;
    const index = this.ensureIndex();
    this.suppress = true;
    try {
      for (const file of listActiveFiles(doc)) {
        await this.materializeFile(file.fileId, index);
      }
      await this.options.setIndex(index);
    } finally {
      this.suppress = false;
    }
  }

  private async materializeFile(fileId: string, index = this.ensureIndex()): Promise<void> {
    if (!this.client) return;
    const doc = this.client.doc;
    const active = listActiveFiles(doc).find((f) => f.fileId === fileId);
    if (!active) {
      // Soft-deleted — remove from disk if present
      const knownPath = index.idToPath[fileId];
      if (knownPath) {
        this.remoteDelete.add(lowerPath(knownPath));
        const existing = this.options.app.vault.getAbstractFileByPath(knownPath);
        if (existing instanceof TFile) {
          await this.options.app.vault.delete(existing);
        }
        delete index.pathToId[lowerPath(knownPath)];
        delete index.idToHash[fileId];
        delete index.idToPath[fileId];
      }
      return;
    }

    if (!this.shouldSync(active.path)) return;

    if (active.kind === "text") {
      const content = getTextContent(doc, fileId) ?? "";
      const hash = await sha256Hex(content);
      const existing = this.options.app.vault.getAbstractFileByPath(active.path);
      const oldPath = index.idToPath[fileId];

      if (oldPath && lowerPath(oldPath) !== lowerPath(active.path)) {
        // Remote rename
        this.remoteRename.add(lowerPath(active.path));
        this.remoteRename.add(lowerPath(oldPath));
        const oldFile = this.options.app.vault.getAbstractFileByPath(oldPath);
        if (oldFile instanceof TFile) {
          await this.options.app.fileManager.renameFile(oldFile, active.path);
        }
      }

      const current = this.options.app.vault.getAbstractFileByPath(active.path);
      if (current instanceof TFile) {
        const disk = await this.options.app.vault.read(current);
        if (disk !== content) {
          await this.options.app.vault.modify(current, content);
        }
      } else {
        await this.ensureFolder(active.path);
        await this.options.app.vault.create(active.path, content);
      }

      index.pathToId[lowerPath(active.path)] = fileId;
      index.idToHash[fileId] = hash;
      index.idToPath[fileId] = active.path;
      void existing;
      return;
    }

    // Binary: download via REST if hash differs
    const { bin } = getVaultMaps(doc);
    const binEntry = bin.get(fileId);
    const remoteHash = binEntry instanceof Y.Map ? String(binEntry.get("hash") ?? "") : "";
    if (index.idToHash[fileId] === remoteHash && this.options.app.vault.getAbstractFileByPath(active.path)) {
      return;
    }

    const { settings } = this.options;
    const http = new LapisClient(settings.serverUrl);
    let bytes: ArrayBuffer;
    try {
      bytes = await http.getFile(settings.vaultId, active.path, settings.syncToken);
    } catch {
      return;
    }

    const oldPath = index.idToPath[fileId];
    if (oldPath && lowerPath(oldPath) !== lowerPath(active.path)) {
      this.remoteRename.add(lowerPath(active.path));
      const oldFile = this.options.app.vault.getAbstractFileByPath(oldPath);
      if (oldFile instanceof TFile) {
        await this.options.app.fileManager.renameFile(oldFile, active.path);
      }
    }

    const current = this.options.app.vault.getAbstractFileByPath(active.path);
    if (current instanceof TFile) {
      await this.options.app.vault.modifyBinary(current, bytes);
    } else {
      await this.ensureFolder(active.path);
      await this.options.app.vault.createBinary(active.path, bytes);
    }
    index.pathToId[lowerPath(active.path)] = fileId;
    index.idToHash[fileId] = remoteHash || (await sha256Hex(bytes));
    index.idToPath[fileId] = active.path;
  }

  private async scanDisk(): Promise<DiskFileSnap[]> {
    const files = this.options.app.vault.getFiles().filter((f) => this.shouldSync(f.path));
    const snaps: DiskFileSnap[] = [];
    for (const file of files) {
      const bytes = await this.options.app.vault.readBinary(file);
      snaps.push({
        path: file.path,
        hash: await sha256Hex(bytes),
        kind: isTextPath(file.path) ? "text" : "binary",
      });
    }
    return snaps;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    if (parts.length <= 1) return;
    let cur = "";
    for (const part of parts.slice(0, -1)) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.options.app.vault.getAbstractFileByPath(cur)) {
        await this.options.app.vault.createFolder(cur);
      }
    }
  }

  private ensureIndex(): FsIndexState {
    const existing = this.options.getIndex();
    if (existing && isValidFsIndex(existing, this.options.settings.vaultId)) {
      return existing;
    }
    return emptyFsIndex(this.options.settings.vaultId);
  }

  private shouldSync(path: string): boolean {
    return shouldSyncPath(path, this.options.settings.receiveInternals);
  }

  private consumeRemoteRename(path: string): boolean {
    const key = lowerPath(path);
    if (this.remoteRename.has(key)) {
      this.remoteRename.delete(key);
      return true;
    }
    return false;
  }

  private consumeRemoteDelete(path: string): boolean {
    const key = lowerPath(path);
    if (this.remoteDelete.has(key)) {
      this.remoteDelete.delete(key);
      return true;
    }
    return false;
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    if (!this.client) return;
    await this.options.setYjsState(this.client.encodeState());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
