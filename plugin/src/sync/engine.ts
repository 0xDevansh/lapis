import { Notice, TFile } from "obsidian";
import type { App, Vault } from "obsidian";
import { LapisClient } from "../net/client";
import type { LapisSettings, ManifestEntry, SyncJournal, VaultManifest } from "../types";
import { createPatch } from "./diff";
import { bytesToBase64, sha256Hex } from "./hash";
import { appendPendingOp, emptyJournal, removeEntry, setEntry } from "./journal";
import { isVaultInternal, lowerPath, shouldSyncPath } from "./paths";

interface LocalFile {
  path: string;
  content: ArrayBuffer;
  contentType: string;
  hash: string;
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
}

export class SyncEngine {
  constructor(private readonly options: SyncEngineOptions) {}

  async firstSync(): Promise<void> {
    if (!this.options.settings.syncToken) {
      new Notice("Lapis: connect before syncing");
      return;
    }

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
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    for (const entry of Object.values(manifest.entries)) {
      const key = lowerPath(entry.path);
      if ((journal.fileRevisions[key] ?? -1) < entry.revision) {
        await this.pullEntry(entry, journal);
      }
    }
    await this.options.setJournal(journal);
  }

  async replayPending(): Promise<void> {
    const journal = this.options.getJournal();
    if (!journal || journal.pendingOps.length === 0) {
      return;
    }

    const pendingOps = [...journal.pendingOps];
    const response = await this.client.batchSync(this.vaultId, pendingOps, this.token);
    for (const result of response.results) {
      if (result.entry) {
        if (result.status === "conflict") {
          await this.pullEntry(result.entry, journal);
        } else {
          setEntry(journal, result.entry);
        }
      }
      if (result.status === "accepted" && result.op.op === "delete") {
        removeEntry(journal, result.op.path);
      }
    }
    journal.pendingOps = [];
    await this.options.setJournal(journal);
    await this.pullChanged();
  }

  async pushLocalChanges(): Promise<{ pushed: number; deleted: number }> {
    if (!this.options.settings.syncToken) {
      return { pushed: 0, deleted: 0 };
    }

    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const localFiles = await this.scanLocalFiles();
    const localByPath = new Map(localFiles.map((file) => [lowerPath(file.path), file]));
    let pushed = 0;
    let deleted = 0;

    for (const file of localFiles) {
      if (journal.fileHashes[lowerPath(file.path)] !== file.hash) {
        await this.pushPut(file.path);
        pushed += 1;
      }
    }

    for (const key of Object.keys(journal.fileRevisions)) {
      if (!localByPath.has(key)) {
        await this.pushDelete(key);
        deleted += 1;
      }
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
    const abstractFile = this.vault.getAbstractFileByPath(path);
    if (!(abstractFile instanceof TFile)) {
      return;
    }

    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const content = await this.vault.readBinary(abstractFile);
    const hash = await sha256Hex(content);
    const key = lowerPath(path);
    if (journal.fileHashes[key] === hash) {
      return;
    }

    const contentType = contentTypeFromPath(path);
    const baseRevision = journal.fileRevisions[key] ?? -1;

    if (isTextContentType(contentType) && baseRevision >= 0) {
      const serverBytes = await this.client.getFile(this.vaultId, path, this.token);
      const serverText = new TextDecoder().decode(serverBytes);
      const clientText = new TextDecoder().decode(content);
      const patch = createPatch(path, serverText, clientText);
      const result = await this.client.applyPatch(this.vaultId, path, patch, baseRevision, clientText, this.token);
      if ("conflict" in result) {
        await this.pullEntry(result.entry, journal);
      } else {
        setEntry(journal, result, hash);
      }
    } else {
      const result = await this.client.putFileWithBaseRevision(this.vaultId, path, content, contentType, baseRevision, this.token);
      if ("conflict" in result) {
        await this.pullEntry(result.entry, journal);
      } else {
        setEntry(journal, result, hash);
      }
    }

    await this.options.setJournal(journal);
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
    const abstractFile = this.vault.getAbstractFileByPath(path);
    if (!(abstractFile instanceof TFile)) {
      return;
    }
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    const content = await this.vault.readBinary(abstractFile);
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

  async applyRemotePut(path: string): Promise<void> {
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    const entry = manifest.entries[lowerPath(path)];
    if (!entry) return;
    const journal = this.options.getJournal() ?? emptyJournal(this.vaultId);
    await this.pullEntry(entry, journal);
    await this.options.setJournal(journal);
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
    let count = 0;
    for (const file of localFiles) {
      count += 1;
      if (count === 1 || count % 20 === 0 || count === localFiles.length) {
        new Notice(`Lapis: seeding ${count} / ${localFiles.length} files`);
      }
      const entry = await this.client.seedFile(this.vaultId, file.path, file.content, file.contentType, this.token);
      if (entry) {
        setEntry(journal, entry, file.hash);
      }
    }

    await this.client.completeSeed(this.vaultId, this.token);
    const manifest = await this.client.getManifest(this.vaultId, this.token);
    await this.options.setJournal(await this.journalFromManifest(manifest));
    new Notice("Lapis: seed complete — initial history sealed");
  }

  private async pullAll(manifest: VaultManifest) {
    const journal = emptyJournal(this.vaultId);
    const entries = Object.values(manifest.entries);
    let count = 0;
    for (const entry of entries) {
      count += 1;
      if (count === 1 || count % 20 === 0 || count === entries.length) {
        new Notice(`Lapis: pulling ${count} / ${entries.length} files`);
      }
      const content = await this.client.getFile(this.vaultId, entry.path, this.token);
      await this.writeLocal(entry.path, content, entry.contentType);
      setEntry(journal, entry, await sha256Hex(content));
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
        continue;
      }

      if (!local && server) {
        await this.pullEntry(server, journal);
        continue;
      }

      if (local && server) {
        const serverHash = await this.hashServerFile(server);
        if (serverHash === local.hash) {
          setEntry(journal, server, local.hash);
        } else {
          // With no shared history, force the normal stale-write path so the server preserves
          // the Web Vault file and captures the local version as a Conflict Note.
          const result = await this.client.putFileWithBaseRevision(this.vaultId, local.path, local.content, local.contentType, -1, this.token);
          if ("conflict" in result) {
            await this.pullEntry(result.entry, journal);
          } else {
            setEntry(journal, result, local.hash);
          }
        }
      }
    }

    await this.options.setJournal(journal);
    new Notice("Lapis: reconcile complete");
  }

  private async pullEntry(entry: ManifestEntry, journal: SyncJournal) {
    const content = await this.client.getFile(this.vaultId, entry.path, this.token);
    await this.writeLocal(entry.path, content, entry.contentType);
    setEntry(journal, entry, await sha256Hex(content));
  }

  private async journalFromManifest(manifest: VaultManifest): Promise<SyncJournal> {
    const journal = emptyJournal(manifest.vaultId);
    for (const entry of Object.values(manifest.entries)) {
      const content = await this.client.getFile(this.vaultId, entry.path, this.token);
      setEntry(journal, entry, await sha256Hex(content));
    }
    return journal;
  }

  private async hashServerFile(entry: ManifestEntry): Promise<string> {
    const content = await this.client.getFile(this.vaultId, entry.path, this.token);
    return sha256Hex(content);
  }

  private async scanLocalFiles(): Promise<LocalFile[]> {
    const files = this.vault.getFiles().filter((file) => shouldSyncPath(file.path, this.options.settings.receiveInternals));
    const localFiles: LocalFile[] = [];
    for (const file of files) {
      const content = await this.vault.readBinary(file);
      localFiles.push({
        path: file.path,
        content,
        contentType: contentTypeFromPath(file.path),
        hash: await sha256Hex(content),
      });
    }
    return localFiles;
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
}

function contentTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
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
