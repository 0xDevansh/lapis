import { Notice, TFile } from "obsidian";
import type { App, Vault } from "obsidian";
import { LapisClient } from "../net/client";
import type {
  LapisSettings,
  ManifestEntry,
  SyncJournal,
  VaultManifest,
  WriteResult,
} from "../types";
import { applyPatch } from "./diff";
import { base64ToBytes, bytesToBase64, sha256Hex } from "./hash";
import { appendPendingOp, emptyJournal, removeEntry, setEntry } from "./journal";
import { isVaultInternal, lowerPath, shouldSyncPath } from "./paths";

interface LocalFile {
  path: string;
  content: ArrayBuffer;
  contentType: string;
  hash: string;
}

export interface SyncProgress {
  phase: "scanning" | "replaying" | "pushing" | "pulling" | "seeding" | "reconciling" | "sealing";
  current: number;
  total: number;
  message: string;
}

export interface SyncDiagnostics {
  connected: boolean;
  vaultId: string;
  journalPresent: boolean;
  localFileCount: number;
  serverFileCount: number | null;
  journalFileCount: number;
  pendingOpCount: number;
  changedPaths: string[];
  deletedPaths: string[];
}

export interface SyncEngineOptions {
  app: App;
  settings: LapisSettings;
  client: LapisClient;
  getJournal: () => SyncJournal | null;
  setJournal: (journal: SyncJournal) => Promise<void>;
  onProgress?: (progress: SyncProgress) => void;
}

export class SyncEngine {
  constructor(private readonly options: SyncEngineOptions) {}

  async forceReconcile(): Promise<void> {
    if (!this.options.settings.syncToken) {
      throw new Error("Connect before syncing");
    }

    await this.replayPending();
    this.reportProgress("scanning", 0, 0, "Scanning every local file…");
    const localFiles = await this.scanLocalFiles();
    this.reportProgress("reconciling", 0, 0, "Loading the server manifest…");
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    await this.reconcile(localFiles, manifest);
    await this.completePendingSeed();
  }

  async completePendingSeed(): Promise<void> {
    const journal = this.options.getJournal();
    if (!journal?.initialSeedPending) return;
    await this.client.completeSeed(this.vaultId, this.token);
    journal.initialSeedPending = false;
    await this.options.setJournal(journal);
  }

  async firstSync(): Promise<void> {
    if (!this.options.settings.syncToken) {
      new Notice("Lapis: connect before syncing");
      return;
    }

    this.reportProgress("scanning", 0, 0, "Scanning local vault…");
    const localFiles = await this.scanLocalFiles();
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const serverEntries = Object.values(manifest.entries);

    if (serverEntries.length === 0) {
      await this.seedLocal(localFiles);
      return;
    }

    if (localFiles.length === 0) {
      await this.pullAll(manifest);
      return;
    }

    await this.reconcile(localFiles, manifest);
  }

  async pullChanged(): Promise<void> {
    if (!this.options.settings.syncToken) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    this.reportProgress("pulling", 0, 0, "Checking for server changes…");
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const changedEntries = Object.values(manifest.entries).filter((entry) => {
      const key = lowerPath(entry.path);
      return (journal.fileRevisions[key] ?? -1) < entry.revision;
    });
    let pulled = 0;
    const applied: ManifestEntry[] = [];
    for (const entry of changedEntries) {
      const key = lowerPath(entry.path);
      if ((journal.fileRevisions[key] ?? -1) < entry.revision) {
        await this.pullEntry(entry, journal);
        applied.push(entry);
        pulled += 1;
        this.reportProgress(
          "pulling",
          pulled,
          changedEntries.length,
          `Downloading ${pulled} of ${changedEntries.length} changed files…`
        );
      }
    }
    await this.options.setJournal(journal);
    for (const entry of applied) {
      await this.ackEntry(entry);
    }
  }

  async replayPending(): Promise<void> {
    const journal = this.options.getJournal();
    if (!journal || journal.pendingOps.length === 0) {
      return;
    }

    const total = journal.pendingOps.length;
    this.reportProgress("replaying", 0, total, `Uploading 0 of ${total} queued changes…`);
    for (let completed = 0; completed < total; completed += 1) {
      const op = journal.pendingOps[0];
      if (!op) break;
      const response = await this.client.batchSync(this.vaultId, [op], this.token);
      const result = response.results[0];
      if (!result) {
        throw new Error(`Queued sync returned no result for ${pendingOpPath(op)}`);
      }
      if (result.entry) {
        const hash =
          op.op === "put"
            ? await sha256Hex(base64ToBytes(op.contentBase64))
            : undefined;
        setEntry(journal, result.entry, hash);
      }
      if (result.status === "accepted" && result.op === "delete") {
        removeEntry(journal, result.path);
      }
      if (result.status !== "accepted") {
        throw new Error(
          `Queued sync failed for ${result.path}: ${result.error ?? result.status}`
        );
      }
      journal.pendingOps.shift();
      await this.options.setJournal(journal);
      if (result.entry) {
        if (isConflictResult(result.entry)) {
          await this.pullConflictNote(result.entry.conflictNote, journal);
        } else {
          await this.ackEntry(result.entry);
        }
      }
      this.reportProgress(
        "replaying",
        completed + 1,
        total,
        `Uploading ${completed + 1} of ${total} queued changes…`
      );
    }
  }

  async pushLocalChanges(): Promise<{ pushed: number; deleted: number }> {
    if (!this.options.settings.syncToken) {
      return { pushed: 0, deleted: 0 };
    }

    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    this.reportProgress("scanning", 0, 0, "Scanning local vault…");
    const localFiles = await this.scanLocalFiles();
    const localByPath = new Map(localFiles.map((file) => [lowerPath(file.path), file]));
    const changedFiles = localFiles.filter(
      (file) => journal.fileHashes[lowerPath(file.path)] !== file.hash
    );
    const deletedPaths = Object.keys(journal.fileRevisions).filter(
      (key) => !localByPath.has(key)
    );
    const total = changedFiles.length + deletedPaths.length;
    let pushed = 0;
    let deleted = 0;
    let completed = 0;

    this.reportProgress("pushing", 0, total, `Uploading 0 of ${total} local changes…`);
    for (const file of changedFiles) {
      await this.pushPut(file.path);
      pushed += 1;
      completed += 1;
      this.reportProgress(
        "pushing",
        completed,
        total,
        `Uploading ${completed} of ${total} local changes…`
      );
    }

    for (const key of deletedPaths) {
      await this.pushDelete(key);
      deleted += 1;
      completed += 1;
      this.reportProgress(
        "pushing",
        completed,
        total,
        `Uploading ${completed} of ${total} local changes…`
      );
    }

    return { pushed, deleted };
  }

  async diagnostics(): Promise<SyncDiagnostics> {
    const journal = this.options.getJournal();
    const localFiles = await this.scanLocalFiles();
    const localByPath = new Map(localFiles.map((file) => [lowerPath(file.path), file]));
    const changedPaths = localFiles
      .filter((file) => journal?.fileHashes[lowerPath(file.path)] !== file.hash)
      .map((file) => file.path);
    const deletedPaths = journal
      ? Object.keys(journal.fileRevisions).filter((path) => !localByPath.has(path))
      : [];

    let serverFileCount: number | null = null;
    if (this.options.settings.syncToken) {
      const manifest = await this.client.getManifest(this.vaultId, this.token);
      serverFileCount = Object.keys(manifest.entries).length;
    }

    return {
      connected: Boolean(this.options.settings.syncToken),
      vaultId: this.vaultId,
      journalPresent: Boolean(journal),
      localFileCount: localFiles.length,
      serverFileCount,
      journalFileCount: journal ? Object.keys(journal.fileRevisions).length : 0,
      pendingOpCount: journal?.pendingOps.length ?? 0,
      changedPaths,
      deletedPaths,
    };
  }

  async pushPut(path: string): Promise<void> {
    if (!shouldSyncPath(path, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const content = await this.readLocalFile(path);
    if (!content) return;
    const hash = await sha256Hex(content);
    const key = lowerPath(path);
    if (journal.fileHashes[key] === hash) {
      return;
    }

    const contentType = contentTypeFromPath(path);
    const baseRevision = journal.fileRevisions[key] ?? -1;
    let result: WriteResult;

    result = await this.client.putFileWithBaseRevision(
      this.vaultId,
      path,
      content,
      contentType,
      baseRevision,
      this.token
    );
    let appliedHash = hash;
    if (!isConflictResult(result) && result.revision > baseRevision + 1) {
      const merged = await this.client.getFile(this.vaultId, result.path, this.token);
      await this.writeLocal(result.path, merged, result.contentType);
      appliedHash = await sha256Hex(merged);
    }
    setEntry(journal, result, appliedHash);

    await this.options.setJournal(journal);
    if (!isConflictResult(result)) {
      await this.ackEntry(result);
    }
  }

  async pushRename(oldPath: string, newPath: string): Promise<void> {
    if (!shouldSyncPath(oldPath, this.options.settings.receiveInternals) || !shouldSyncPath(newPath, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const entry = await this.client.renameFile(this.vaultId, oldPath, newPath, this.token);
    const oldHash = journal.fileHashes[lowerPath(oldPath)];
    removeEntry(journal, oldPath);
    setEntry(journal, entry, oldHash);
    await this.options.setJournal(journal);
    await this.ackEntry(entry);
  }

  async pushDelete(path: string): Promise<void> {
    if (!shouldSyncPath(path, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    await this.client.deleteFile(this.vaultId, path, this.token);
    removeEntry(journal, path);
    await this.options.setJournal(journal);
  }

  async queuePut(path: string): Promise<void> {
    if (!shouldSyncPath(path, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const content = await this.readLocalFile(path);
    if (!content) return;
    appendPendingOp(journal, {
      op: "put",
      path,
      contentBase64: bytesToBase64(content),
      contentType: contentTypeFromPath(path),
      baseRevision: journal.fileRevisions[lowerPath(path)],
    });
    await this.options.setJournal(journal);
  }

  async queueRename(oldPath: string, newPath: string): Promise<void> {
    if (!shouldSyncPath(oldPath, this.options.settings.receiveInternals) || !shouldSyncPath(newPath, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    appendPendingOp(journal, { op: "rename", oldPath, newPath });
    await this.options.setJournal(journal);
  }

  async queueDelete(path: string): Promise<void> {
    if (!shouldSyncPath(path, this.options.settings.receiveInternals)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    appendPendingOp(journal, { op: "delete", path });
    await this.options.setJournal(journal);
  }

  async applyRemotePut(path: string, revision?: number, patch?: string, baseRevision?: number): Promise<void> {
    if (patch && revision !== undefined && baseRevision !== undefined) {
      const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
      const key = lowerPath(path);
      const existingRevision = journal.fileRevisions[key] ?? -1;
      const existing = this.vault.getAbstractFileByPath(path);
      if (existingRevision === baseRevision && existing instanceof TFile) {
        const current = await this.vault.read(existing);
        const next = applyPatch(current, patch);
        if (next !== null) {
          await this.vault.modify(existing, next);
          const bytes = new TextEncoder().encode(next).buffer as ArrayBuffer;
          setEntry(journal, {
            path,
            size: bytes.byteLength,
            contentType: contentTypeFromPath(path),
            updatedAt: new Date().toISOString(),
            revision,
          }, await sha256Hex(bytes));
          await this.options.setJournal(journal);
          await this.ackEntry({
            path,
            size: bytes.byteLength,
            contentType: contentTypeFromPath(path),
            updatedAt: new Date().toISOString(),
            revision,
          });
          return;
        }
      }
    }
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const entry = manifest.entries[lowerPath(path)];
    if (!entry) return;
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    await this.pullEntry(entry, journal);
    await this.options.setJournal(journal);
    await this.ackEntry(entry);
  }

  async applyRemoteRename(oldPath: string, newPath: string): Promise<void> {
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const existing = this.vault.getAbstractFileByPath(oldPath);
    if (existing instanceof TFile && !this.vault.getAbstractFileByPath(newPath)) {
      await this.ensureParent(newPath);
      await this.vault.rename(existing, newPath);
    } else {
      await this.applyRemotePut(newPath);
    }
    const oldHash = journal.fileHashes[lowerPath(oldPath)];
    removeEntry(journal, oldPath);
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const entry = manifest.entries[lowerPath(newPath)];
    if (entry) setEntry(journal, entry, oldHash);
    await this.options.setJournal(journal);
  }

  async applyRemoteDelete(path: string): Promise<void> {
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.delete(existing);
    }
    removeEntry(journal, path);
    await this.options.setJournal(journal);
  }

  private async seedLocal(localFiles: LocalFile[]) {
    const journal = emptyJournal(this.vaultId);
    journal.initialSeedPending = true;
    await this.options.setJournal(journal);
    let count = 0;
    this.reportProgress(
      "seeding",
      0,
      localFiles.length,
      `Uploading 0 of ${localFiles.length} files…`
    );
    for (const file of localFiles) {
      count += 1;
      if (count === 1 || count % 20 === 0 || count === localFiles.length) {
        new Notice(`Lapis: seeding ${count} / ${localFiles.length} files`);
      }
      const entry = await this.client.seedFile(this.vaultId, file.path, file.content, file.contentType, this.token);
      if (entry) {
        setEntry(journal, entry, file.hash);
        // Persist each accepted upload so a failed or slow initial seal does
        // not make the next sync start the entire seed again.
        await this.options.setJournal(journal);
        await this.ackEntry(entry);
      }
      this.reportProgress(
        "seeding",
        count,
        localFiles.length,
        `Uploading ${count} of ${localFiles.length} files…`
      );
    }

    new Notice("Lapis: uploads complete — sealing initial history");
    this.reportProgress(
      "sealing",
      localFiles.length,
      localFiles.length,
      "Uploads complete — sealing initial history…"
    );
    await this.client.completeSeed(this.vaultId, this.token);
    journal.initialSeedPending = false;
    await this.options.setJournal(journal);
    new Notice("Lapis: seed complete — initial history sealed");
  }

  private async pullAll(manifest: VaultManifest) {
    const journal = emptyJournal(this.vaultId);
    const entries = Object.values(manifest.entries);
    let count = 0;
    this.reportProgress(
      "pulling",
      0,
      entries.length,
      `Downloading 0 of ${entries.length} files…`
    );
    for (const entry of entries) {
      count += 1;
      if (count === 1 || count % 20 === 0 || count === entries.length) {
        new Notice(`Lapis: pulling ${count} / ${entries.length} files`);
      }
      await this.pullEntry(entry, journal);
      await this.options.setJournal(journal);
      await this.ackEntry(entry);
      this.reportProgress(
        "pulling",
        count,
        entries.length,
        `Downloading ${count} of ${entries.length} files…`
      );
    }
    await this.options.setJournal(journal);
    new Notice("Lapis: pull complete");
  }

  private async reconcile(localFiles: LocalFile[], manifest: VaultManifest) {
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const localByPath = new Map(localFiles.map((file) => [lowerPath(file.path), file]));
    const serverByPath = new Map(Object.values(manifest.entries).map((entry) => [lowerPath(entry.path), entry]));
    const keys = new Set([...localByPath.keys(), ...serverByPath.keys()]);
    let count = 0;
    this.reportReconcileProgress(0, keys.size);

    for (const key of keys) {
      count += 1;
      if (count === 1 || count % 20 === 0 || count === keys.size) {
        new Notice(`Lapis: reconciling ${count} / ${keys.size} files`);
      }

      const local = localByPath.get(key);
      const server = serverByPath.get(key);

      if (local && !server) {
        const entry = await this.client.putFile(this.vaultId, local.path, local.content, local.contentType, this.token);
        setEntry(journal, entry, local.hash);
        await this.options.setJournal(journal);
        await this.ackEntry(entry);
        this.reportReconcileProgress(count, keys.size);
        continue;
      }

      if (!local && server) {
        await this.pullEntry(server, journal);
        await this.options.setJournal(journal);
        await this.ackEntry(server);
        this.reportReconcileProgress(count, keys.size);
        continue;
      }

      if (local && server) {
        const serverHash = await this.hashServerFile(server);
        if (serverHash === local.hash) {
          setEntry(journal, server, local.hash);
          await this.ackEntry(server);
        } else {
          const baseRevision = journal.fileRevisions[key] ?? -1;
          const result = await this.client.putFileWithBaseRevision(
            this.vaultId,
            local.path,
            local.content,
            local.contentType,
            baseRevision,
            this.token
          );
          let appliedHash = local.hash;
          if (!isConflictResult(result)) {
            const merged = await this.client.getFile(
              this.vaultId,
              result.path,
              this.token
            );
            await this.writeLocal(result.path, merged, result.contentType);
            appliedHash = await sha256Hex(merged);
          }
          setEntry(journal, result, appliedHash);
          await this.options.setJournal(journal);
          if (isConflictResult(result)) {
            await this.pullConflictNote(result.conflictNote, journal);
          } else {
            await this.ackEntry(result);
          }
        }
      }
      this.reportReconcileProgress(count, keys.size);
    }

    await this.options.setJournal(journal);
    new Notice("Lapis: reconcile complete");
  }

  private async pullEntry(entry: ManifestEntry, journal: SyncJournal) {
    const content = await this.client.getFile(this.vaultId, entry.path, this.token);
    await this.writeLocal(entry.path, content, entry.contentType);
    setEntry(journal, entry, await sha256Hex(content));
  }

  private async ackEntry(entry: ManifestEntry): Promise<void> {
    await this.client.postAcks(
      this.vaultId,
      [{ path: entry.path, revision: entry.revision }],
      this.token
    );
  }

  private async pullConflictNote(
    conflictNote: string | undefined,
    journal: SyncJournal
  ): Promise<void> {
    if (!conflictNote) return;
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const entry = manifest.entries[lowerPath(conflictNote)];
    if (!entry) return;
    await this.pullEntry(entry, journal);
    await this.options.setJournal(journal);
    await this.ackEntry(entry);
  }

  private async hashServerFile(entry: ManifestEntry): Promise<string> {
    const content = await this.client.getFile(this.vaultId, entry.path, this.token);
    return sha256Hex(content);
  }

  private async scanLocalFiles(): Promise<LocalFile[]> {
    const files = this.vault.getFiles().filter((file) => shouldSyncPath(file.path, this.options.settings.receiveInternals));
    const localFiles = new Map<string, LocalFile>();
    for (const file of files) {
      const content = await this.vault.readBinary(file);
      localFiles.set(lowerPath(file.path), {
        path: file.path,
        content,
        contentType: contentTypeFromPath(file.path),
        hash: await sha256Hex(content),
      });
    }
    if (this.options.settings.receiveInternals) {
      await this.scanAdapterFolder(".obsidian", localFiles);
      await this.scanAdapterFolder(".trash", localFiles);
    }
    return [...localFiles.values()];
  }

  private async readLocalFile(path: string): Promise<ArrayBuffer | null> {
    if (isVaultInternal(path)) {
      if (!(await this.vault.adapter.exists(path))) return null;
      return this.vault.adapter.readBinary(path);
    }
    const file = this.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.vault.readBinary(file) : null;
  }

  private async scanAdapterFolder(
    folder: string,
    files: Map<string, LocalFile>
  ): Promise<void> {
    if (!(await this.vault.adapter.exists(folder))) return;
    const listed = await this.vault.adapter.list(folder);
    for (const path of listed.files) {
      if (
        !shouldSyncPath(path, true) ||
        lowerPath(path).startsWith(".obsidian/plugins/lapis-sync/")
      ) {
        continue;
      }
      const content = await this.vault.adapter.readBinary(path);
      files.set(lowerPath(path), {
        path,
        content,
        contentType: contentTypeFromPath(path),
        hash: await sha256Hex(content),
      });
    }
    for (const child of listed.folders) {
      if (
        lowerPath(child) === ".obsidian/plugins/lapis-sync" ||
        lowerPath(child).startsWith(".obsidian/plugins/lapis-sync/")
      ) {
        continue;
      }
      await this.scanAdapterFolder(child, files);
    }
  }

  private async writeLocal(path: string, content: ArrayBuffer, contentType: string) {
    if (isVaultInternal(path)) {
      await this.ensureAdapterParent(path);
      if (isTextContentType(contentType)) {
        await this.vault.adapter.write(path, new TextDecoder().decode(content));
      } else {
        await this.vault.adapter.writeBinary(path, content);
      }
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);
    if (isTextContentType(contentType)) {
      const text = new TextDecoder().decode(content);
      if (existing instanceof TFile) {
        await this.vault.modify(existing, text);
      } else {
        await this.ensureParent(path);
        await this.vault.create(path, text);
      }
      return;
    }

    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, content);
    } else {
      await this.ensureParent(path);
      await this.vault.createBinary(path, content);
    }
  }

  private async ensureParent(path: string) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }

  private async ensureAdapterParent(path: string) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.vault.adapter.exists(current))) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }

  private get client(): LapisClient {
    return this.options.client;
  }

  private get vault(): Vault {
    return this.options.app.vault;
  }

  private get vaultId(): string {
    return this.options.settings.vaultId;
  }

  private get token(): string {
    return this.options.settings.syncToken;
  }

  private reportReconcileProgress(current: number, total: number): void {
    this.reportProgress(
      "reconciling",
      current,
      total,
      `Reconciling ${current} of ${total} files…`
    );
  }

  private reportProgress(
    phase: SyncProgress["phase"],
    current: number,
    total: number,
    message: string
  ): void {
    this.options.onProgress?.({ phase, current, total, message });
  }
}

function pendingOpPath(op: SyncJournal["pendingOps"][number]): string {
  return op.op === "rename" ? op.oldPath : op.path;
}

function contentTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "txt":
    case "toml":
      return "text/plain; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "text/javascript; charset=utf-8";
    case "ts":
    case "tsx":
      return "text/typescript; charset=utf-8";
    case "json":
    case "canvas":
      return "application/json";
    case "xml":
      return "application/xml";
    case "yaml":
    case "yml":
      return "text/yaml; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("svg");
}

function isConflictResult(result: WriteResult): boolean {
  return result.conflict !== undefined || result.conflictNote !== undefined;
}
