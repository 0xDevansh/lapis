import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  type ManifestEntry,
  type VaultManifest,
  contentKey,
  emptyManifest,
  hasCaseDuplicate,
  isAncestorPath,
  manifestKey,
} from "./manifest";
import { isValidVaultPath, isVaultInternal } from "./path";
import { applyPatch, merge3 } from "./patch";
import { indexFile, removeFromIndex } from "../search/indexer";
import {
  getVaultLog,
  sealToRemote,
  type IncrementalSealChange,
  type SealedCommit,
} from "../artifacts/sealer";
import {
  conflictNotePath,
  parseConflictNoteMetadata,
  renderConflictNote,
  type ConflictContext,
} from "./conflict";
import { listVaultDevices } from "../devices/record";
import { identityFromRecord, type ConflictPolicy } from "../devices/types";
import { ArtifactsRemote } from "../git/artifacts-remote";
import { createGitHubRemote } from "../git/github-remote";
import { getGitRemote, updateGitRemoteState } from "../git/store";
import { reconcileInbound } from "../git/reconcile";
import {
  CURRENT_STORAGE_VERSION,
  R2_TEXT_STORAGE_VERSION,
  SQLITE_TEXT_STORAGE_VERSION,
  STORAGE_VERSION_STATE_KEY,
  TEXT_MIGRATION_STATE_KEY,
  isTextContentType,
  type AckRequest,
  type ConflictPayload,
  type ConflictResolutionAction,
  type ConflictResolutionResult,
  type ResolveConflictRequest,
  type StorageVersion,
} from "./contracts";
import { initializeTextStoreSchema, TextStore } from "./text-store";

export type {
  AckRequest,
  ConflictPayload,
  ConflictResolutionResult,
  ResolveConflictRequest,
} from "./contracts";

export interface VaultMeta {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  artifactsRemote?: string | null;
}

type VaultMetaRow = Record<string, SqlStorageValue> & {
  id: SqlStorageValue;
  ownerId: SqlStorageValue;
  name: SqlStorageValue;
  createdAt: SqlStorageValue;
  artifactsRemote: SqlStorageValue;
};

type ManifestEntryRow = Record<string, SqlStorageValue> & {
  pathLower: SqlStorageValue;
  path: SqlStorageValue;
  size: SqlStorageValue;
  contentType: SqlStorageValue;
  updatedAt: SqlStorageValue;
  revision: SqlStorageValue;
  r2Revision: SqlStorageValue;
};

type PendingOpRow = Record<string, SqlStorageValue> & {
  seq: SqlStorageValue;
  pathLower: SqlStorageValue;
  kind: SqlStorageValue;
  path: SqlStorageValue;
  oldPath: SqlStorageValue;
  newPath: SqlStorageValue;
  patch: SqlStorageValue;
  contentType: SqlStorageValue;
  baseRevision: SqlStorageValue;
  newRevision: SqlStorageValue;
  author: SqlStorageValue;
  ts: SqlStorageValue;
};

type DirtyRow = Record<string, SqlStorageValue> & {
  pathLower: SqlStorageValue;
  path: SqlStorageValue;
  deleted: SqlStorageValue;
};

type ConflictRow = Record<string, SqlStorageValue> & {
  conflictNote: SqlStorageValue;
  path: SqlStorageValue;
  serverRevision: SqlStorageValue;
  clientBaseRevision: SqlStorageValue;
  isBinary: SqlStorageValue;
};

export interface ChangeNotification {
  type: "change";
  path: string;
  kind: "put" | "rename" | "delete";
  baseRevision?: number;
  revision?: number;
  patch?: string;
  newPath?: string;
  author?: string;
  ts: string;
}

export interface PresenceNotification {
  type: "presence";
  sessions: Array<{ identity: string; openPath: string | null }>;
}

export interface SameFileWarning {
  type: "same_file_warning";
  path: string;
  others: string[];
}

export interface WriteResult extends ManifestEntry {
  conflictNote?: string;
  conflict?: ConflictPayload;
}

export interface ConflictNotification {
  type: "conflict";
  conflict: ConflictPayload;
  author: string;
  ts: string;
}

export interface ConflictResolvedNotification {
  type: "conflict_resolved";
  path: string;
  conflictNote: string;
  action: ConflictResolutionAction;
  revision: number;
  author: string;
  ts: string;
}

export interface VaultContentResult {
  path: string;
  contentType: string;
  revision: number;
  bytes: ArrayBuffer;
}

type ServerMessage =
  | ChangeNotification
  | PresenceNotification
  | SameFileWarning
  | ConflictNotification
  | ConflictResolvedNotification;

interface PresenceEntry {
  identity: string;
  openPath: string | null;
}

type AttachedWebSocket = WebSocket & {
  serializeAttachment(value: PresenceEntry): void;
  deserializeAttachment(): PresenceEntry | undefined;
};

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_SEAL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_FLUSH_MAX_PENDING = 250;

export class VaultCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly textStore: TextStore;
  private readonly presence = new Map<WebSocket, PresenceEntry>();
  private readonly headContent = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.textStore = new TextStore(ctx.storage);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        id                TEXT PRIMARY KEY,
        owner_id          TEXT NOT NULL,
        name              TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        artifacts_remote  TEXT
      );

      CREATE TABLE IF NOT EXISTS manifest_entries (
        path_lower    TEXT PRIMARY KEY,
        path          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        content_type  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        revision      INTEGER NOT NULL,
        r2_revision   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_ops (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        path_lower     TEXT NOT NULL,
        kind           TEXT NOT NULL,
        path           TEXT NOT NULL,
        old_path       TEXT,
        new_path       TEXT,
        patch          TEXT,
        content_type   TEXT,
        base_revision  INTEGER,
        new_revision   INTEGER,
        author         TEXT,
        ts             TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_ops_path ON pending_ops(path_lower, seq);

      CREATE TABLE IF NOT EXISTS seal_dirty (
        path_lower TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS do_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_note_lower TEXT PRIMARY KEY,
        conflict_note       TEXT NOT NULL,
        path_lower          TEXT NOT NULL,
        path                TEXT NOT NULL,
        server_revision     INTEGER NOT NULL,
        client_base_revision INTEGER NOT NULL,
        is_binary           INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        resolved_at         TEXT,
        resolution_action   TEXT,
        delete_pending      INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_conflicts_open
        ON conflicts(path_lower, resolved_at);
    `);
    initializeTextStoreSchema(this.sql);
  }

  async initialize(meta: VaultMeta): Promise<void> {
    const isNewVault = (await this.getMeta()) === null;
    this.sql.exec(
      `INSERT OR IGNORE INTO vault_meta (id, owner_id, name, created_at)
       VALUES (?, ?, ?, ?)`,
      meta.id,
      meta.ownerId,
      meta.name,
      meta.createdAt
    );
    if (isNewVault && this.numberState(STORAGE_VERSION_STATE_KEY) === null) {
      await this.setState(STORAGE_VERSION_STATE_KEY, String(CURRENT_STORAGE_VERSION));
    }
    await this.ensureManifestLoaded(meta.id);
    await this.ensureSealScheduled();
  }

  getStorageVersion(): StorageVersion {
    const version = this.numberState(STORAGE_VERSION_STATE_KEY);
    return version !== null && Number.isInteger(version) && version >= 1
      ? version
      : R2_TEXT_STORAGE_VERSION;
  }

  async recordAcks(
    vaultId: string,
    deviceKey: string,
    request: AckRequest
  ): Promise<{ accepted: number }> {
    await this.ensureManifestLoaded(vaultId);
    let accepted = 0;
    const touched = new Set<string>();

    for (const ack of request.acks ?? []) {
      const entry = this.getEntry(ack.path);
      if (!entry || !isTextContentType(entry.contentType)) continue;
      if (!Number.isInteger(ack.revision) || ack.revision < 0 || ack.revision > entry.revision) {
        throw Object.assign(new Error(`Invalid ack revision for ${ack.path}`), {
          status: 400,
        });
      }
      if (this.textStore.setAck(deviceKey, entry.path, ack.revision)) {
        accepted += 1;
        touched.add(entry.path);
      }
    }

    const retainedDeviceKeys = await this.retainedAckDeviceKeys(vaultId, deviceKey);
    for (const path of touched) {
      this.advanceCheckpointFromAcks(path, retainedDeviceKeys);
    }
    return { accepted };
  }

  async resolveConflict(
    vaultId: string,
    request: ResolveConflictRequest,
    author = "web"
  ): Promise<ConflictResolutionResult> {
    await this.ensureManifestLoaded(vaultId);
    if (!isValidVaultPath(request.path)) {
      throw Object.assign(new Error("Invalid conflict path"), { status: 400 });
    }
    if (
      !isValidVaultPath(request.conflictNote) ||
      !lowerPath(request.conflictNote).startsWith(".sync-conflicts/")
    ) {
      throw Object.assign(new Error("Invalid conflict note"), { status: 400 });
    }
    if (
      request.action !== "keep-server" &&
      request.action !== "keep-client" &&
      request.action !== "use-merged"
    ) {
      throw Object.assign(new Error("Invalid conflict action"), { status: 400 });
    }

    let conflict = this.sql.exec<ConflictRow>(
      `SELECT conflict_note AS conflictNote, path,
              server_revision AS serverRevision,
              client_base_revision AS clientBaseRevision,
              is_binary AS isBinary
       FROM conflicts
       WHERE conflict_note_lower = ? AND path_lower = ? AND resolved_at IS NULL`,
      lowerPath(request.conflictNote),
      lowerPath(request.path)
    ).toArray()[0];
    const noteEntry = this.getEntry(request.conflictNote);
    if (!noteEntry) {
      throw Object.assign(new Error("Conflict not found"), { status: 404 });
    }
    if (!conflict) {
      const metadata = parseConflictNoteMetadata(
        await this.headText(vaultId, noteEntry.path)
      );
      if (!metadata || lowerPath(metadata.path) !== lowerPath(request.path)) {
        throw Object.assign(new Error("Conflict not found"), { status: 404 });
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO conflicts
         (conflict_note_lower, conflict_note, path_lower, path,
          server_revision, client_base_revision, is_binary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        lowerPath(request.conflictNote),
        request.conflictNote,
        lowerPath(metadata.path),
        metadata.path,
        metadata.serverRevision,
        metadata.clientBaseRevision,
        metadata.isBinary ? 1 : 0,
        noteEntry.updatedAt
      );
      conflict = {
        conflictNote: request.conflictNote,
        path: metadata.path,
        serverRevision: metadata.serverRevision,
        clientBaseRevision: metadata.clientBaseRevision,
        isBinary: metadata.isBinary ? 1 : 0,
      };
    }

    const current = this.getEntry(request.path);
    if (!current) {
      throw Object.assign(new Error("Conflicted file not found"), { status: 404 });
    }
    if (Number(conflict.isBinary) === 1 && request.action !== "keep-server") {
      throw Object.assign(
        new Error("Binary conflicts only support keep-server through this endpoint"),
        { status: 400 }
      );
    }

    let entry: ManifestEntry = current;
    if (request.action !== "keep-server") {
      if (typeof request.content !== "string") {
        throw Object.assign(new Error("content is required for this action"), {
          status: 400,
        });
      }
      entry = await this.applyPut(
        vaultId,
        current.path,
        new TextEncoder().encode(request.content).buffer as ArrayBuffer,
        current.contentType,
        current.revision,
        author,
        "rebase"
      );
    }

    const resolvedAt = new Date().toISOString();
    this.sql.exec(
      `UPDATE conflicts
       SET resolved_at = ?, resolution_action = ?, delete_pending = 1
       WHERE conflict_note_lower = ? AND resolved_at IS NULL`,
      resolvedAt,
      request.action,
      lowerPath(request.conflictNote)
    );
    try {
      await this.deleteFile(vaultId, request.conflictNote, author);
      this.sql.exec(
        `UPDATE conflicts SET delete_pending = 0 WHERE conflict_note_lower = ?`,
        lowerPath(request.conflictNote)
      );
    } catch (error) {
      console.error(
        `[lapis] Conflict note cleanup deferred for ${request.conflictNote}`,
        error
      );
    }

    this.broadcast({
      type: "conflict_resolved",
      path: current.path,
      conflictNote: request.conflictNote,
      action: request.action,
      revision: entry.revision,
      author,
      ts: resolvedAt,
    });
    return {
      entry,
      conflictNote: request.conflictNote,
      action: request.action,
    };
  }

  async getMeta(): Promise<VaultMeta | null> {
    const row = this.sql.exec<VaultMetaRow>(
      `SELECT id, owner_id AS ownerId, name, created_at AS createdAt,
              artifacts_remote AS artifactsRemote
       FROM vault_meta LIMIT 1`
    ).toArray()[0];
    if (!row) return null;
    return {
      id: String(row.id),
      ownerId: String(row.ownerId),
      name: String(row.name),
      createdAt: String(row.createdAt),
      artifactsRemote: row.artifactsRemote != null ? String(row.artifactsRemote) : null,
    };
  }

  setArtifactsRemote(remote: string): void {
    this.sql.exec(
      `UPDATE vault_meta SET artifacts_remote = ? WHERE id = (SELECT id FROM vault_meta LIMIT 1)`,
      remote
    );
  }

  async getManifest(vaultId: string): Promise<VaultManifest> {
    await this.ensureManifestLoaded(vaultId);
    return this.manifestFromSql(vaultId);
  }

  async getContent(vaultId: string, path: string): Promise<VaultContentResult | null> {
    await this.ensureManifestLoaded(vaultId);
    const entry = this.getEntry(path);
    if (!entry) return null;
    if (this.hasPendingDelete(path)) return null;

    if (isTextContentType(entry.contentType)) {
      const text = await this.headText(vaultId, entry.path);
      const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
      return { path: entry.path, contentType: entry.contentType, revision: entry.revision, bytes };
    }

    const obj = await this.env.VAULT_BUCKET.get(contentKey(vaultId, entry.path));
    if (!obj) return null;
    return {
      path: entry.path,
      contentType: obj.httpMetadata?.contentType ?? entry.contentType,
      revision: entry.revision,
      bytes: await obj.arrayBuffer(),
    };
  }

  async listContent(vaultId: string): Promise<Array<{ path: string; data: Uint8Array }>> {
    const manifest = await this.getManifest(vaultId);
    const result: Array<{ path: string; data: Uint8Array }> = [];
    for (const entry of Object.values(manifest.entries)) {
      if (isVaultInternal(entry.path)) continue;
      const content = await this.getContent(vaultId, entry.path);
      if (content) result.push({ path: content.path, data: new Uint8Array(content.bytes) });
    }
    return result;
  }

  async putFile(vaultId: string, path: string, body: ArrayBuffer, contentType: string): Promise<ManifestEntry> {
    return this.applyPut(vaultId, path, body, contentType, undefined, "web");
  }

  async syncPutFile(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    baseRevision?: number,
    author = "device",
    conflictPolicy: ConflictPolicy = "rebase"
  ): Promise<WriteResult> {
    return this.applyPut(vaultId, path, body, contentType, baseRevision, author, conflictPolicy);
  }

  async syncApplyPatch(
    vaultId: string,
    path: string,
    patch: string,
    baseRevision: number,
    author = "device",
    conflictPolicy: ConflictPolicy = "rebase"
  ): Promise<WriteResult> {
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(path)) throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });

    await this.ensureManifestLoaded(vaultId);
    const entry = this.getEntry(path);
    if (!entry) throw Object.assign(new Error("File not found"), { status: 404 });

    if (baseRevision === entry.revision) {
      const original = await this.headText(vaultId, entry.path);
      const patched = applyPatch(original, patch);
      if (patched === null) throw Object.assign(new Error("Patch does not apply cleanly"), { status: 422 });
      return this.commitTextHead(vaultId, entry, patched, baseRevision, author, patch);
    }

    const baseText = await this.resolveBaseText(vaultId, path, entry, baseRevision);
    if (baseText === null) {
      return this.recordTextConflict(
        vaultId,
        path,
        entry,
        baseRevision,
        undefined,
        author,
        conflictPolicy,
        undefined,
        patch
      );
    }
    const resolvedBase = baseText;
    const theirs = applyPatch(resolvedBase, patch);
    if (theirs === null) {
      return this.recordTextConflict(vaultId, path, entry, baseRevision, resolvedBase, author, conflictPolicy, undefined, patch);
    }
    return this.handleStaleTextWrite(vaultId, path, entry, baseRevision, theirs, author, conflictPolicy, resolvedBase);
  }

  async renameFile(vaultId: string, oldPath: string, newPath: string, author = "web"): Promise<ManifestEntry> {
    await this.ensureManifestLoaded(vaultId);
    if (!isValidVaultPath(oldPath) || !isValidVaultPath(newPath)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(newPath)) throw Object.assign(new Error("Cannot move to vault internals"), { status: 400 });
    if (oldPath === newPath) throw Object.assign(new Error("Source and destination are the same"), { status: 400 });
    if (isAncestorPath(oldPath, newPath)) throw Object.assign(new Error("Cannot move a folder into itself"), { status: 400 });

    const oldEntry = this.getEntry(oldPath);
    if (!oldEntry) throw Object.assign(new Error("Source not found"), { status: 404 });
    if (hasCaseDuplicate(await this.getManifest(vaultId), newPath, oldPath)) {
      throw Object.assign(new Error("Case conflict at destination"), { status: 409 });
    }

    const sqliteText =
      this.usesSqliteText() && isTextContentType(oldEntry.contentType);
    if (sqliteText) {
      this.textStore.renameFile(oldEntry.path, newPath);
      this.sql.exec(
        `DELETE FROM pending_ops WHERE path_lower = ?`,
        lowerPath(oldEntry.path)
      );
    } else {
      // Fold legacy text changes first so the deferred rename has a stable R2 source.
      await this.flushPathToR2(vaultId, oldEntry.path);
    }

    const next: ManifestEntry = {
      ...oldEntry,
      path: newPath,
      r2Key: contentKey(vaultId, newPath),
      updatedAt: new Date().toISOString(),
      revision: oldEntry.revision + 1,
    };
    this.deleteEntry(oldEntry.path);
    this.upsertEntry(next, oldEntry.revision);
    const cachedText = this.headContent.get(lowerPath(oldEntry.path));
    this.headContent.delete(lowerPath(oldEntry.path));
    if (cachedText !== undefined && sqliteText) {
      this.headContent.set(lowerPath(newPath), cachedText);
    }
    this.appendPending({
      path: newPath,
      kind: "rename",
      oldPath: oldEntry.path,
      newPath,
      contentType: next.contentType,
      baseRevision: oldEntry.revision,
      newRevision: next.revision,
      author,
    });
    this.markDirty(oldEntry.path, true);
    this.markDirty(newPath, false);
    await this.scheduleFlush();
    this.broadcast({
      type: "change",
      path: oldEntry.path,
      kind: "rename",
      baseRevision: oldEntry.revision,
      revision: next.revision,
      newPath,
      author,
      ts: next.updatedAt,
    });
    return next;
  }

  async syncRenameFile(vaultId: string, oldPath: string, newPath: string, author = "device"): Promise<ManifestEntry> {
    return this.renameFile(vaultId, oldPath, newPath, author);
  }

  async deleteFile(vaultId: string, path: string, author = "web"): Promise<void> {
    await this.ensureManifestLoaded(vaultId);
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });

    const entry = this.getEntry(path);
    if (!entry) return;
    if (this.usesSqliteText() && isTextContentType(entry.contentType)) {
      this.textStore.deleteFile(entry.path);
    } else {
      await this.flushPathToR2(vaultId, entry.path);
    }

    this.deleteEntry(entry.path);
    this.headContent.delete(lowerPath(entry.path));
    this.appendPending({
      path: entry.path,
      kind: "delete",
      contentType: entry.contentType,
      baseRevision: entry.revision,
      newRevision: entry.revision + 1,
      author,
    });
    this.markDirty(entry.path, true);
    await this.scheduleFlush();
    this.broadcast({
      type: "change",
      path: entry.path,
      kind: "delete",
      baseRevision: entry.revision,
      author,
      ts: new Date().toISOString(),
    });
  }

  async syncDeleteFile(vaultId: string, path: string, author = "device"): Promise<void> {
    return this.deleteFile(vaultId, path, author);
  }

  async flushToR2(vaultId?: string): Promise<void> {
    const meta = vaultId ? null : await this.getMeta();
    const id = vaultId ?? meta?.id;
    if (!id) return;
    await this.ensureManifestLoaded(id);

    const rows = this.sql.exec<PendingOpRow>(pendingSelect(`ORDER BY seq`)).toArray();
    if (rows.length === 0) {
      await this.writeManifestToR2(id);
      await this.clearState("flush_deadline");
      return;
    }

    const touched = new Set(rows.map((row) => String(row.pathLower)));
    for (const key of touched) {
      const keyRows = rows.filter((row) => String(row.pathLower) === key);
      const last = keyRows[keyRows.length - 1];
      const kind = String(last.kind);
      const path = String(last.path);
      const textOp = isTextContentType(String(last.contentType ?? ""));
      const sqliteText = this.usesSqliteText() && textOp;

      if (kind === "delete") {
        if (!sqliteText) {
          await this.env.VAULT_BUCKET.delete(contentKey(id, path));
        }
        removeFromIndex(this.env.DB, id, path).catch(() => {});
        continue;
      }

      const rename = keyRows.find((row) => String(row.kind) === "rename");
      if (rename && !sqliteText) {
        const oldPath = String(rename.oldPath);
        const newPath = String(rename.newPath);
        const oldObj = await this.env.VAULT_BUCKET.get(contentKey(id, oldPath));
        if (oldObj) {
          await this.env.VAULT_BUCKET.put(contentKey(id, newPath), await oldObj.arrayBuffer(), {
            httpMetadata: { contentType: oldObj.httpMetadata?.contentType ?? String(rename.contentType ?? "application/octet-stream") },
          });
          await this.env.VAULT_BUCKET.delete(contentKey(id, oldPath));
          removeFromIndex(this.env.DB, id, oldPath).catch(() => {});
        }
      }

      const entry = this.getEntry(path);
      if (!entry) continue;
      if (isTextContentType(entry.contentType)) {
        const text = await this.headText(id, entry.path);
        if (!this.usesSqliteText()) {
          const bytes = new TextEncoder().encode(text);
          await this.env.VAULT_BUCKET.put(contentKey(id, entry.path), bytes, {
            httpMetadata: { contentType: entry.contentType },
          });
          this.setR2Revision(entry.path, entry.revision);
        }
        const manifest = this.manifestFromSql(id);
        indexFile(this.env.DB, {
          vaultId: id,
          path: entry.path,
          content: text,
          vaultPaths: Object.values(manifest.entries).map((item) => item.path),
        }).catch(() => {});
      } else {
        this.setR2Revision(entry.path, entry.revision);
      }
    }

    this.sql.exec(`DELETE FROM pending_ops`);
    this.headContent.clear();
    await this.writeManifestToR2(id);
    await this.clearState("flush_deadline");
  }

  async sealNow(label?: string): Promise<{ commitHash?: string; fileCount: number; remote?: string }> {
    const meta = await this.getMeta();
    if (!meta) throw Object.assign(new Error("Vault not found"), { status: 404 });
    await this.flushToR2(meta.id);

    const gitConfig = await getGitRemote(this.env.DB, meta.id);
    if (gitConfig && this.env.GITHUB_PAT_ENCRYPTION_KEY) {
      try {
        await updateGitRemoteState(this.env.DB, meta.id, { syncState: "pulling" });
        const remote = await createGitHubRemote(
          {
            repoUrl: gitConfig.repoUrl,
            branch: gitConfig.branch,
            subdir: gitConfig.subdir,
            patCiphertext: gitConfig.patCiphertext,
          },
          this.env.GITHUB_PAT_ENCRYPTION_KEY
        );
        const inbound = await reconcileInbound({
          remote,
          vaultId: meta.id,
          lastSyncedCommit: gitConfig.lastSyncedCommit,
          getHeadText: (path) => this.headText(meta.id, path),
          getEntry: (path) => this.getEntry(path),
          applyMerged: async (path, content, author) => {
            const entry = this.getEntry(path);
            if (!entry) {
              return this.applyPut(
                meta.id,
                path,
                new TextEncoder().encode(content).buffer as ArrayBuffer,
                "text/markdown",
                undefined,
                author
              );
            }
            return this.commitTextHead(meta.id, entry, content, entry.revision, author);
          },
          writeConflictNote: (ctx, author) => this.writeConflictNote(meta.id, ctx, author),
        });
        for (const change of inbound.applied) {
          this.broadcast(change);
        }
        await updateGitRemoteState(this.env.DB, meta.id, { syncState: "pushing" });
      } catch (err) {
        console.error(`[lapis] Git inbound sync failed for vault ${meta.id}:`, err);
        await updateGitRemoteState(this.env.DB, meta.id, { syncState: "conflict" });
      }
    }

    const changes = this.dirtyChanges();
    if (changes.length === 0) {
      const remoteUrl = gitConfig?.repoUrl ?? meta.artifactsRemote;
      if (remoteUrl) await this.scheduleNextSeal();
      return { fileCount: 0, remote: remoteUrl ?? undefined };
    }

    try {
      let result: { commitHash: string; remote: string; fileCount: number };
      if (gitConfig && this.env.GITHUB_PAT_ENCRYPTION_KEY) {
        const remote = await createGitHubRemote(
          {
            repoUrl: gitConfig.repoUrl,
            branch: gitConfig.branch,
            subdir: gitConfig.subdir,
            patCiphertext: gitConfig.patCiphertext,
          },
          this.env.GITHUB_PAT_ENCRYPTION_KEY
        );
        result = await sealToRemote(
          remote,
          meta.id,
          changes,
          async (path) => {
            const content = await this.getContent(meta.id, path);
            return content?.bytes ?? null;
          },
          label
        );
        await updateGitRemoteState(this.env.DB, meta.id, {
          syncState: "idle",
          lastSyncedCommit: result.commitHash || gitConfig.lastSyncedCommit,
          lastSyncedAt: new Date().toISOString(),
        });
      } else if (meta.artifactsRemote || changes.length > 0) {
        const artifactsRemote = await ArtifactsRemote.create(this.env.ARTIFACTS, meta.id, meta.artifactsRemote ?? null);
        result = await sealToRemote(
          artifactsRemote,
          meta.id,
          changes,
          async (path) => {
            const content = await this.getContent(meta.id, path);
            return content?.bytes ?? null;
          },
          label
        );
        if (!meta.artifactsRemote || meta.artifactsRemote !== result.remote) {
          this.setArtifactsRemote(result.remote);
        }
      } else {
        await this.scheduleNextSeal();
        return { fileCount: 0 };
      }

      this.sql.exec(`DELETE FROM seal_dirty`);
      await this.setState("last_seal_at", String(Date.now()));
      await this.scheduleNextSeal();
      return result;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "NON_FAST_FORWARD" && gitConfig) {
        await updateGitRemoteState(this.env.DB, meta.id, { syncState: "conflict" });
      }
      throw err;
    }
  }

  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    const now = Date.now();
    const flushDeadline = this.numberState("flush_deadline");
    const sealDeadline = this.numberState("seal_deadline");

    await this.advanceAllCheckpointsFromAcks(meta.id, now);
    await this.retryResolvedConflictDeletes(meta.id);

    if (flushDeadline !== null && flushDeadline <= now) {
      await this.flushToR2(meta.id);
    }

    if (sealDeadline !== null && sealDeadline <= now) {
      try {
        const result = await this.sealNow();
        console.log(`[lapis] Sealed vault ${meta.id}: ${result.commitHash ?? "no changes"} (${result.fileCount} files)`);
      } catch (err) {
        const e = err as Error;
        console.error(`[lapis] Seal failed for vault ${meta.id}: ${e?.message ?? err}`, e?.stack ?? "");
        await this.scheduleNextSeal();
      }
    }

    await this.armAlarm();
  }

  async getLog(limit = 50): Promise<SealedCommit[]> {
    const meta = await this.getMeta();
    if (!meta) return [];
    return getVaultLog(this.env.ARTIFACTS, meta.id, meta.artifactsRemote ?? null, limit);
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        this.presence.delete(ws);
      }
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === "open") {
      const path = typeof parsed.path === "string" ? parsed.path : null;
      const entry = this.getPresence(ws);
      if (entry) {
        entry.openPath = path;
        this.setPresence(ws, entry);
      }
      if (path) {
        const others: string[] = [];
        for (const otherWs of this.ctx.getWebSockets()) {
          const otherEntry = this.getPresence(otherWs);
          if (otherWs !== ws && otherEntry && otherEntry.openPath === path) others.push(otherEntry.identity);
        }
        if (others.length > 0) this.sendTo(ws, { type: "same_file_warning", path, others });
      }
      this.broadcast(this.presenceSnapshot());
    }

    if (parsed.type === "close_file") {
      const entry = this.getPresence(ws);
      if (entry) {
        entry.openPath = null;
        this.setPresence(ws, entry);
      }
      this.broadcast(this.presenceSnapshot());
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.presence.delete(ws);
    this.broadcast(this.presenceSnapshot());
  }

  webSocketError(ws: WebSocket): void {
    this.presence.delete(ws);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/meta" && request.method === "GET") {
      const meta = await this.getMeta();
      if (!meta) return new Response("Not found", { status: 404 });
      return Response.json(meta);
    }
    if (url.pathname === "/init" && request.method === "POST") {
      const body = (await request.json()) as VaultMeta;
      await this.initialize(body);
      return new Response("OK");
    }
    if (url.pathname === "/ws" && request.method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
      const identity = url.searchParams.get("identity") ?? "unknown";
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      this.setPresence(server, { identity, openPath: null });
      server.send(JSON.stringify(this.presenceSnapshot()));
      this.broadcast(this.presenceSnapshot());
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  private async applyPut(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    baseRevision: number | undefined,
    author: string,
    conflictPolicy: ConflictPolicy = "rebase"
  ): Promise<WriteResult> {
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(path)) throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });
    await this.ensureManifestLoaded(vaultId);

    const existing = this.getEntry(path);
    if (existing && baseRevision !== undefined && baseRevision !== existing.revision) {
      if (!isTextContentType(contentType)) {
        return this.recordBinaryConflict(vaultId, path, existing, baseRevision, author);
      }
      const modified = decodeUtf8(body);
      const baseText = await this.resolveBaseText(vaultId, path, existing, baseRevision);
      if (baseText === null) {
        return this.recordTextConflict(
          vaultId,
          path,
          existing,
          baseRevision,
          undefined,
          author,
          conflictPolicy,
          undefined,
          modified
        );
      }
      const resolvedBase = baseText;
      return this.handleStaleTextWrite(vaultId, path, existing, baseRevision, modified, author, conflictPolicy, resolvedBase);
    }

    if (hasCaseDuplicate(await this.getManifest(vaultId), path)) {
      throw Object.assign(new Error("Case conflict: a file with a similar name already exists"), { status: 409 });
    }

    const now = new Date().toISOString();
    const previousRevision = existing?.revision ?? 0;
    const nextRevision = previousRevision + 1;
    const entry: ManifestEntry = {
      path,
      r2Key: contentKey(vaultId, path),
      size: body.byteLength,
      contentType,
      updatedAt: now,
      revision: nextRevision,
    };

    if (!isTextContentType(contentType)) {
      await this.env.VAULT_BUCKET.put(contentKey(vaultId, path), body, { httpMetadata: { contentType } });
      if (
        this.usesSqliteText() &&
        existing &&
        isTextContentType(existing.contentType)
      ) {
        this.textStore.deleteFile(existing.path);
        this.headContent.delete(lowerPath(existing.path));
      }
      this.upsertEntry(entry, nextRevision);
      this.markDirty(path, false);
      await this.scheduleFlush();
      this.broadcast({ type: "change", path, kind: "put", baseRevision: previousRevision, revision: nextRevision, author, ts: now });
      return entry;
    }

    let original = "";
    if (existing) {
      if (isTextContentType(existing.contentType)) {
        original = await this.headText(vaultId, existing.path);
      } else {
        const object = await this.env.VAULT_BUCKET.get(contentKey(vaultId, existing.path));
        original = object ? await object.text() : "";
      }
    }
    const modified = decodeUtf8(body);
    const patch = createLinePatch(path, original, modified);
    if (this.usesSqliteText()) {
      this.textStore.writeFile({
        path,
        revision: nextRevision,
        contentType,
        updatedAt: now,
        text: modified,
      });
      if (existing && isTextContentType(existing.contentType)) {
        this.textStore.appendUpdate({
          path,
          fromRevision: previousRevision,
          toRevision: nextRevision,
          patch,
        });
      } else {
        this.textStore.writeCheckpoint({
          path,
          revision: nextRevision,
          text: modified,
          createdAt: now,
        });
      }
    }
    this.upsertEntry(
      entry,
      this.usesSqliteText() ? 0 : (existing?.r2Revision ?? 0)
    );
    this.headContent.set(lowerPath(path), modified);
    this.appendPending({
      path,
      kind: existing ? "patch" : "put",
      patch,
      contentType,
      baseRevision: existing ? previousRevision : 0,
      newRevision: nextRevision,
      author,
    });
    this.markDirty(path, false);
    await this.scheduleFlush();
    this.broadcast({
      type: "change",
      path,
      kind: "put",
      baseRevision: existing ? previousRevision : 0,
      revision: nextRevision,
      patch,
      author,
      ts: now,
    });
    return entry;
  }

  private async ensureManifestLoaded(vaultId: string): Promise<void> {
    const existing = this.sql.exec(`SELECT path_lower FROM manifest_entries LIMIT 1`).toArray();
    if (existing.length === 0) {
      const obj = await this.env.VAULT_BUCKET.get(manifestKey(vaultId));
      if (!obj) return;
      const manifest = (await obj.json()) as VaultManifest;
      for (const entry of Object.values(manifest.entries)) {
        this.upsertEntry(entry, entry.revision);
      }
    }
    await this.ensureTextStorageMigrated(vaultId);
  }

  private async ensureTextStorageMigrated(vaultId: string): Promise<void> {
    if (this.getStorageVersion() >= SQLITE_TEXT_STORAGE_VERSION) return;

    await this.setState(TEXT_MIGRATION_STATE_KEY, "pending");
    const entries = Object.values(this.manifestFromSql(vaultId).entries).filter((entry) =>
      isTextContentType(entry.contentType)
    );

    try {
      for (const entry of entries) {
        const text = await this.materializeText(vaultId, entry.path);
        const existing = this.textStore.readFile(entry.path);
        const existingMatches =
          existing?.metadata.revision === entry.revision &&
          existing.metadata.size === entry.size &&
          existing.text === text;

        if (!existingMatches) {
          this.textStore.writeFile({
            path: entry.path,
            revision: entry.revision,
            contentType: entry.contentType,
            updatedAt: entry.updatedAt,
            text,
          });
        }

        const stored = this.textStore.readFile(entry.path);
        const storedSize = stored
          ? new TextEncoder().encode(stored.text).byteLength
          : -1;
        if (
          !stored ||
          stored.metadata.revision !== entry.revision ||
          stored.metadata.contentType !== entry.contentType ||
          stored.metadata.size !== entry.size ||
          storedSize !== entry.size ||
          stored.text !== text
        ) {
          await this.setState(TEXT_MIGRATION_STATE_KEY, "failed");
          throw Object.assign(new Error(`Text migration verification failed for ${entry.path}`), {
            status: 500,
          });
        }

        this.textStore.writeCheckpoint({
          path: entry.path,
          revision: entry.revision,
          text,
          createdAt: entry.updatedAt,
        });
        await this.env.VAULT_BUCKET.delete(
          contentKey(vaultId, this.r2BasePathFor(entry.path))
        );
        this.setR2Revision(entry.path, 0);
        this.headContent.delete(lowerPath(entry.path));
      }

      await this.setState(STORAGE_VERSION_STATE_KEY, String(SQLITE_TEXT_STORAGE_VERSION));
      await this.setState(TEXT_MIGRATION_STATE_KEY, "complete");
    } catch (error) {
      await this.setState(TEXT_MIGRATION_STATE_KEY, "failed");
      throw error;
    }
  }

  private manifestFromSql(vaultId: string): VaultManifest {
    const entries: Record<string, ManifestEntry> = {};
    for (const row of this.sql.exec<ManifestEntryRow>(
      `SELECT path_lower AS pathLower, path, size, content_type AS contentType,
              updated_at AS updatedAt, revision, r2_revision AS r2Revision
       FROM manifest_entries ORDER BY path`
    ).toArray()) {
      const entry = entryFromRow(row, vaultId);
      entries[lowerPath(entry.path)] = entry;
    }
    return { ...emptyManifest(vaultId), updatedAt: new Date().toISOString(), entries };
  }

  private getEntry(path: string): (ManifestEntry & { r2Revision: number }) | null {
    const row = this.sql.exec<ManifestEntryRow>(
      `SELECT path_lower AS pathLower, path, size, content_type AS contentType,
              updated_at AS updatedAt, revision, r2_revision AS r2Revision
       FROM manifest_entries WHERE path_lower = ?`,
      lowerPath(path)
    ).toArray()[0];
    return row ? entryFromRow(row, this.metaVaultId()) : null;
  }

  private upsertEntry(entry: ManifestEntry, r2Revision: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO manifest_entries
       (path_lower, path, size, content_type, updated_at, revision, r2_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lowerPath(entry.path),
      entry.path,
      entry.size,
      entry.contentType,
      entry.updatedAt,
      entry.revision,
      r2Revision
    );
  }

  private deleteEntry(path: string): void {
    this.sql.exec(`DELETE FROM manifest_entries WHERE path_lower = ?`, lowerPath(path));
  }

  private bumpEntry(path: string, size: number, contentType: string): ManifestEntry {
    const existing = this.getEntry(path);
    if (!existing) throw Object.assign(new Error("File not found"), { status: 404 });
    const entry: ManifestEntry = {
      path: existing.path,
      r2Key: existing.r2Key,
      size,
      contentType,
      updatedAt: new Date().toISOString(),
      revision: existing.revision + 1,
    };
    this.upsertEntry(entry, existing.r2Revision);
    return entry;
  }

  private setR2Revision(path: string, revision: number): void {
    this.sql.exec(`UPDATE manifest_entries SET r2_revision = ? WHERE path_lower = ?`, revision, lowerPath(path));
  }

  private appendPending(input: {
    path: string;
    kind: "put" | "patch" | "rename" | "delete";
    oldPath?: string;
    newPath?: string;
    patch?: string;
    contentType?: string;
    baseRevision?: number;
    newRevision?: number;
    author?: string;
  }): void {
    this.sql.exec(
      `INSERT INTO pending_ops
       (path_lower, kind, path, old_path, new_path, patch, content_type, base_revision, new_revision, author, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lowerPath(input.path),
      input.kind,
      input.path,
      input.oldPath ?? null,
      input.newPath ?? null,
      input.patch ?? null,
      input.contentType ?? null,
      input.baseRevision ?? null,
      input.newRevision ?? null,
      input.author ?? null,
      new Date().toISOString()
    );
  }

  private async headText(vaultId: string, path: string): Promise<string> {
    const key = lowerPath(path);
    const cached = this.headContent.get(key);
    if (cached !== undefined) return cached;
    let text: string;
    if (this.usesSqliteText()) {
      const stored = this.textStore.readFile(path);
      if (!stored) {
        throw Object.assign(new Error(`SQLite text head missing for ${path}`), {
          status: 500,
        });
      }
      text = stored.text;
    } else {
      text = await this.materializeText(vaultId, path);
    }
    this.headContent.set(key, text);
    return text;
  }

  private async materializeText(vaultId: string, path: string): Promise<string> {
    const basePath = this.r2BasePathFor(path);
    const obj = await this.env.VAULT_BUCKET.get(contentKey(vaultId, basePath));
    let text = obj ? await obj.text() : "";
    for (const row of this.sql.exec<PendingOpRow>(
      pendingSelect(`WHERE path_lower = ? ORDER BY seq`),
      lowerPath(path)
    ).toArray()) {
      const kind = String(row.kind);
      if (kind === "patch" || kind === "put") {
        const patch = String(row.patch ?? "");
        if (!patch.trim()) continue;
        const next = applyPatch(text, patch);
        if (next === null) throw Object.assign(new Error(`Pending patch does not apply for ${path}`), { status: 500 });
        text = next;
      }
    }
    return text;
  }

  private r2BasePathFor(path: string): string {
    const row = this.sql.exec<PendingOpRow>(
      pendingSelect(`WHERE path_lower = ? AND kind = 'rename' ORDER BY seq LIMIT 1`),
      lowerPath(path)
    ).toArray()[0];
    return row?.oldPath != null ? String(row.oldPath) : path;
  }

  private async flushPathToR2(vaultId: string, path: string): Promise<void> {
    if (this.usesSqliteText()) return;
    const rows = this.sql.exec<PendingOpRow>(
      pendingSelect(`WHERE path_lower = ? ORDER BY seq`),
      lowerPath(path)
    ).toArray();
    if (rows.length === 0) return;
    const entry = this.getEntry(path);
    if (!entry || !isTextContentType(entry.contentType)) return;
    const text = await this.headText(vaultId, entry.path);
    await this.env.VAULT_BUCKET.put(contentKey(vaultId, entry.path), new TextEncoder().encode(text), {
      httpMetadata: { contentType: entry.contentType },
    });
    this.setR2Revision(entry.path, entry.revision);
    this.sql.exec(`DELETE FROM pending_ops WHERE path_lower = ?`, lowerPath(path));
    this.headContent.delete(lowerPath(path));
  }

  private markDirty(path: string, deleted: boolean): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO seal_dirty (path_lower, path, deleted) VALUES (?, ?, ?)`,
      lowerPath(path),
      path,
      deleted ? 1 : 0
    );
  }

  private dirtyChanges(): IncrementalSealChange[] {
    return this.sql.exec<DirtyRow>(
      `SELECT path_lower AS pathLower, path, deleted FROM seal_dirty ORDER BY path`
    ).toArray().map((row) => ({ path: String(row.path), deleted: Number(row.deleted) === 1 }));
  }

  private async writeManifestToR2(vaultId: string): Promise<void> {
    const manifest = this.manifestFromSql(vaultId);
    await this.env.VAULT_BUCKET.put(manifestKey(vaultId), JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  private hasPendingDelete(path: string): boolean {
    const row = this.sql.exec(`SELECT seq FROM pending_ops WHERE path_lower = ? AND kind = 'delete' LIMIT 1`, lowerPath(path)).toArray()[0];
    return Boolean(row);
  }

  private async resolveBaseText(
    vaultId: string,
    path: string,
    entry: ManifestEntry & { r2Revision: number },
    baseRevision: number
  ): Promise<string | null> {
    if (baseRevision > entry.revision) return null;
    if (this.usesSqliteText()) {
      return this.textStore.reconstruct(path, baseRevision);
    }
    if (baseRevision < entry.r2Revision) return null;

    let text: string;
    const rows = this.sql.exec<PendingOpRow>(
      pendingSelect(`WHERE path_lower = ? ORDER BY seq`),
      lowerPath(path)
    ).toArray();
    if (this.usesSqliteText()) {
      if (rows.length === 0 || Number(rows[0].baseRevision ?? -1) !== 0) {
        return null;
      }
      text = "";
    } else {
      const obj = await this.env.VAULT_BUCKET.get(contentKey(vaultId, this.r2BasePathFor(path)));
      text = obj ? await obj.text() : "";
    }

    for (const row of rows) {
      const newRev = Number(row.newRevision ?? 0);
      if (newRev > baseRevision) break;
      const kind = String(row.kind);
      if (kind === "patch" || kind === "put") {
        const patch = String(row.patch ?? "");
        if (!patch.trim()) continue;
        const next = applyPatch(text, patch);
        if (next === null) return null;
        text = next;
      }
    }
    return text;
  }

  private async commitTextHead(
    vaultId: string,
    entry: ManifestEntry & { r2Revision: number },
    merged: string,
    baseRevision: number,
    author: string,
    patch?: string
  ): Promise<WriteResult> {
    const ours = await this.headText(vaultId, entry.path);
    const storagePatch = createLinePatch(entry.path, ours, merged);
    const effectivePatch = patch ?? storagePatch;
    const encoded = new TextEncoder().encode(merged);
    const next = this.bumpEntry(entry.path, encoded.byteLength, entry.contentType);
    if (this.usesSqliteText()) {
      this.textStore.writeFile({
        path: next.path,
        revision: next.revision,
        contentType: next.contentType,
        updatedAt: next.updatedAt,
        text: merged,
      });
      this.textStore.appendUpdate({
        path: next.path,
        fromRevision: entry.revision,
        toRevision: next.revision,
        patch: storagePatch,
      });
    }
    this.headContent.set(lowerPath(entry.path), merged);
    this.appendPending({
      path: entry.path,
      kind: "patch",
      patch: effectivePatch,
      contentType: entry.contentType,
      baseRevision,
      newRevision: next.revision,
      author,
    });
    this.markDirty(entry.path, false);
    await this.scheduleFlush();
    this.broadcast({
      type: "change",
      path: entry.path,
      kind: "put",
      baseRevision,
      revision: next.revision,
      patch: effectivePatch,
      author,
      ts: next.updatedAt,
    });
    return next;
  }

  private advanceCheckpointFromAcks(
    path: string,
    retainedDeviceKeys: ReadonlySet<string>,
    now = Date.now()
  ): void {
    const entry = this.getEntry(path);
    if (!entry || !isTextContentType(entry.contentType)) return;
    const minAck =
      this.textStore.minAckRevision(entry.path, retainedDeviceKeys, now) ??
      entry.revision;
    this.textStore.advanceCheckpoint(entry.path, Math.min(minAck, entry.revision));
  }

  private async advanceAllCheckpointsFromAcks(
    vaultId: string,
    now = Date.now()
  ): Promise<void> {
    const retainedDeviceKeys = await this.retainedAckDeviceKeys(vaultId);
    const manifest = this.manifestFromSql(vaultId);
    for (const entry of Object.values(manifest.entries)) {
      if (isTextContentType(entry.contentType)) {
        this.advanceCheckpointFromAcks(entry.path, retainedDeviceKeys, now);
      }
    }
  }

  private async retainedAckDeviceKeys(
    vaultId: string,
    currentDeviceKey?: string
  ): Promise<Set<string>> {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const retained = new Set<string>();
    for (const device of await listVaultDevices(this.env.DB, vaultId)) {
      const lastSeenAt = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
      if (
        device.capabilities.bidirectional &&
        Number.isFinite(lastSeenAt) &&
        lastSeenAt >= cutoff
      ) {
        retained.add(identityFromRecord(device).author);
      }
    }
    if (currentDeviceKey && !currentDeviceKey.startsWith("web:")) {
      retained.add(currentDeviceKey);
    }
    return retained;
  }

  private async retryResolvedConflictDeletes(vaultId: string): Promise<void> {
    const rows = this.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT conflict_note AS conflictNote
       FROM conflicts
       WHERE resolved_at IS NOT NULL AND delete_pending = 1`
    ).toArray();
    for (const row of rows) {
      const conflictNote = String(row.conflictNote);
      try {
        await this.deleteFile(vaultId, conflictNote, "system:conflict-cleanup");
        this.sql.exec(
          `UPDATE conflicts SET delete_pending = 0 WHERE conflict_note_lower = ?`,
          lowerPath(conflictNote)
        );
      } catch (error) {
        console.error(
          `[lapis] Conflict note cleanup retry failed for ${conflictNote}`,
          error
        );
      }
    }
  }

  private async handleStaleTextWrite(
    vaultId: string,
    path: string,
    entry: ManifestEntry & { r2Revision: number },
    baseRevision: number,
    theirs: string,
    author: string,
    conflictPolicy: ConflictPolicy,
    resolvedBase: string
  ): Promise<WriteResult> {
    const ours = await this.headText(vaultId, path);
    const { merged, hasConflicts } = merge3(resolvedBase, ours, theirs);

    if (!hasConflicts) {
      return this.commitTextHead(vaultId, entry, merged, entry.revision, author);
    }

    return this.recordTextConflict(vaultId, path, entry, baseRevision, resolvedBase, author, conflictPolicy, ours, theirs);
  }

  private async recordTextConflict(
    vaultId: string,
    path: string,
    entry: ManifestEntry & { r2Revision: number },
    baseRevision: number,
    baseContent: string | undefined,
    author: string,
    _conflictPolicy: ConflictPolicy,
    serverContent?: string,
    clientContent?: string
  ): Promise<WriteResult> {
    const ours = serverContent ?? (await this.headText(vaultId, path));
    const ctx: ConflictContext = {
      path,
      serverContent: ours,
      clientContent,
      baseContent: baseContent === ours ? undefined : baseContent,
      serverRevision: entry.revision,
      clientBaseRevision: baseRevision,
      deviceName: author,
      timestamp: new Date().toISOString(),
    };
    const notePath = await this.writeConflictNote(vaultId, ctx, author);
    const conflict = this.openConflict(ctx, notePath, author);
    return { ...entry, conflictNote: notePath, conflict };
  }

  private async recordBinaryConflict(
    vaultId: string,
    path: string,
    entry: ManifestEntry & { r2Revision: number },
    baseRevision: number,
    author: string
  ): Promise<WriteResult> {
    const ctx: ConflictContext = {
      path,
      serverRevision: entry.revision,
      clientBaseRevision: baseRevision,
      deviceName: author,
      timestamp: new Date().toISOString(),
      isBinary: true,
    };
    const notePath = await this.writeConflictNote(vaultId, ctx, author);
    const conflict = this.openConflict(ctx, notePath, author);
    return { ...entry, conflictNote: notePath, conflict };
  }

  private openConflict(
    ctx: ConflictContext,
    conflictNote: string,
    author: string
  ): ConflictPayload {
    const conflict: ConflictPayload = {
      path: ctx.path,
      conflictNote,
      serverRevision: ctx.serverRevision,
      clientBaseRevision: ctx.clientBaseRevision,
      serverContent: ctx.serverContent,
      clientContent: ctx.clientContent,
      baseContent: ctx.baseContent,
      isBinary: ctx.isBinary,
    };
    this.sql.exec(
      `INSERT OR REPLACE INTO conflicts
       (conflict_note_lower, conflict_note, path_lower, path,
        server_revision, client_base_revision, is_binary, created_at,
        resolved_at, resolution_action, delete_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
      lowerPath(conflictNote),
      conflictNote,
      lowerPath(ctx.path),
      ctx.path,
      ctx.serverRevision,
      ctx.clientBaseRevision,
      ctx.isBinary ? 1 : 0,
      ctx.timestamp
    );
    this.broadcast({
      type: "conflict",
      conflict,
      author,
      ts: ctx.timestamp,
    });
    return conflict;
  }

  private async writeConflictNote(vaultId: string, ctx: ConflictContext, author: string): Promise<string> {
    const notePath = conflictNotePath(ctx);
    const body = renderConflictNote(ctx);
    await this.applyPut(
      vaultId,
      notePath,
      new TextEncoder().encode(body).buffer as ArrayBuffer,
      "text/markdown",
      undefined,
      author,
      "rebase"
    );
    return notePath;
  }

  private assertBaseRevision(entry: ManifestEntry, baseRevision: number): void {
    if (entry.revision !== baseRevision) {
      throw Object.assign(
        new Error(`Revision conflict: server has ${entry.revision}, client base is ${baseRevision}`),
        { status: 409, serverRevision: entry.revision, headRevision: entry.revision }
      );
    }
  }

  private async scheduleFlush(): Promise<void> {
    const deadline = Date.now() + (this.numberState("flush_interval_ms") ?? DEFAULT_FLUSH_INTERVAL_MS);
    await this.setState("flush_deadline", String(deadline));
    const pendingCount = this.sql.exec(`SELECT seq FROM pending_ops LIMIT ?`, DEFAULT_FLUSH_MAX_PENDING + 1).toArray().length;
    if (pendingCount > (this.numberState("flush_max_pending") ?? DEFAULT_FLUSH_MAX_PENDING)) {
      const meta = await this.getMeta();
      if (meta) await this.flushToR2(meta.id);
      return;
    }
    await this.armAlarm();
  }

  private async ensureSealScheduled(): Promise<void> {
    if (this.numberState("seal_deadline") === null) await this.scheduleNextSeal();
  }

  private async scheduleNextSeal(): Promise<void> {
    await this.setState("seal_deadline", String(Date.now() + DEFAULT_SEAL_INTERVAL_MS));
    await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    const deadlines = [this.numberState("flush_deadline"), this.numberState("seal_deadline")]
      .filter((value): value is number => value !== null);
    if (deadlines.length === 0) return;
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private async setState(key: string, value: string): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO do_state (key, value) VALUES (?, ?)`, key, value);
  }

  private async clearState(key: string): Promise<void> {
    this.sql.exec(`DELETE FROM do_state WHERE key = ?`, key);
  }

  private numberState(key: string): number | null {
    const row = this.sql.exec<Record<string, SqlStorageValue>>(`SELECT value FROM do_state WHERE key = ?`, key).toArray()[0];
    if (!row) return null;
    const value = Number(row.value);
    return Number.isFinite(value) ? value : null;
  }

  private usesSqliteText(): boolean {
    return this.getStorageVersion() >= SQLITE_TEXT_STORAGE_VERSION;
  }

  private presenceSnapshot(): PresenceNotification {
    const sessions: PresenceNotification["sessions"] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const entry = this.getPresence(ws);
      if (entry) sessions.push({ identity: entry.identity, openPath: entry.openPath });
    }
    return { type: "presence", sessions };
  }

  private getPresence(ws: WebSocket): PresenceEntry | undefined {
    return this.presence.get(ws) ?? (ws as AttachedWebSocket).deserializeAttachment?.();
  }

  private setPresence(ws: WebSocket, entry: PresenceEntry): void {
    this.presence.set(ws, entry);
    (ws as AttachedWebSocket).serializeAttachment?.(entry);
  }

  private sendTo(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // ignore
    }
  }

  private metaVaultId(): string {
    const meta = this.sql.exec<VaultMetaRow>(`SELECT id FROM vault_meta LIMIT 1`).toArray()[0];
    return meta ? String(meta.id) : "";
  }
}

function entryFromRow(row: ManifestEntryRow, vaultId: string): ManifestEntry & { r2Revision: number } {
  const path = String(row.path);
  return {
    path,
    r2Key: contentKey(vaultId, path),
    size: Number(row.size),
    contentType: String(row.contentType),
    updatedAt: String(row.updatedAt),
    revision: Number(row.revision),
    r2Revision: Number(row.r2Revision),
  };
}

function pendingSelect(suffix: string): string {
  return `
    SELECT seq, path_lower AS pathLower, kind, path, old_path AS oldPath,
           new_path AS newPath, patch, content_type AS contentType,
           base_revision AS baseRevision, new_revision AS newRevision,
           author, ts
    FROM pending_ops ${suffix}
  `;
}

function lowerPath(path: string): string {
  return path.toLowerCase();
}

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true,
  }).decode(bytes);
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.replace(/\n$/, "").split("\n");
}

function createLinePatch(path: string, original: string, modified: string): string {
  if (original === modified) return "";
  const before = splitLines(original);
  const after = splitLines(modified);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix + prefix < before.length &&
    suffix + prefix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const contextBefore = before.slice(Math.max(0, prefix - 3), prefix);
  const contextAfter = before.slice(before.length - suffix, Math.min(before.length, before.length - suffix + 3));
  const origStart = Math.max(1, prefix - contextBefore.length + 1);
  const newStart = Math.max(1, prefix - contextBefore.length + 1);
  const origLen = contextBefore.length + removed.length + contextAfter.length;
  const newLen = contextBefore.length + added.length + contextAfter.length;

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${origStart},${origLen} +${newStart},${newLen} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
    "",
  ].join("\n");
}
