import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  type ManifestEntry,
  type VaultManifest,
  contentKey,
  emptyManifest,
  manifestKey,
} from "./manifest";
import { isValidVaultPath, isVaultInternal } from "./path";
import { indexFile, removeFromIndex } from "../search/indexer";
import {
  getRemoteLog,
  sealToRemote,
  type IncrementalSealChange,
  type SealedCommit,
} from "../git/sealer";
import { conflictNotePath, renderConflictNote, type ConflictContext } from "./conflict";
import { createGitHubRemote } from "../git/github-remote";
import { getGitRemote, updateGitRemoteState } from "../git/store";
import { reconcileInbound } from "../git/reconcile";
import { YjsRoom } from "./yjs-room";
import { setBinaryMeta, getTextContent, getVaultMaps, listActiveFiles, setTextFile, renameFile as yjsRenameFile, softDeleteFile as yjsSoftDelete } from "./yjs/schema";

export interface VaultMeta {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
}

type VaultMetaRow = Record<string, SqlStorageValue> & {
  id: SqlStorageValue;
  ownerId: SqlStorageValue;
  name: SqlStorageValue;
  createdAt: SqlStorageValue;
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
}

export interface VaultContentResult {
  path: string;
  contentType: string;
  revision: number;
  bytes: ArrayBuffer;
}

type ServerMessage = ChangeNotification | PresenceNotification | SameFileWarning;

interface PresenceEntry {
  identity: string;
  openPath: string | null;
}

type AttachedWebSocket = WebSocket & {
  serializeAttachment(value: PresenceEntry): void;
  deserializeAttachment(): PresenceEntry | undefined;
};

const DEFAULT_SEAL_INTERVAL_MS = 5 * 60_000;

export class VaultCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly presence = new Map<WebSocket, PresenceEntry>();
  private readonly yjs: YjsRoom;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.yjs = new YjsRoom(
      this.sql,
      () => this.ctx.getWebSockets("yjs"),
      async (at) => {
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > at) {
          await this.ctx.storage.setAlarm(at);
        }
      }
    );
    this.yjs.setDebounceHandler(() => {
      void this.reindexFromYjs();
      this.markYjsDirtyForSeal();
      void this.armAlarm();
    });
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
    `);
  }

  async initialize(meta: VaultMeta): Promise<void> {
    this.sql.exec(
      `INSERT OR IGNORE INTO vault_meta (id, owner_id, name, created_at)
       VALUES (?, ?, ?, ?)`,
      meta.id,
      meta.ownerId,
      meta.name,
      meta.createdAt
    );
    await this.ensureManifestLoaded(meta.id);
  }

  async getMeta(): Promise<VaultMeta | null> {
    const row = this.sql.exec<VaultMetaRow>(
      `SELECT id, owner_id AS ownerId, name, created_at AS createdAt
       FROM vault_meta LIMIT 1`
    ).toArray()[0];
    if (!row) return null;
    return {
      id: String(row.id),
      ownerId: String(row.ownerId),
      name: String(row.name),
      createdAt: String(row.createdAt),
    };
  }

  async getManifest(vaultId: string): Promise<VaultManifest> {
    await this.ensureYjsMigrated(vaultId);
    const files = this.yjs.manifest();
    const now = new Date().toISOString();
    const entries: Record<string, ManifestEntry> = {};
    for (const f of files) {
      entries[f.path.toLowerCase()] = {
        path: f.path,
        size: f.size,
        contentType: f.contentType,
        updatedAt: now,
        revision: 1,
        r2Key: f.r2Key ?? contentKey(vaultId, f.path),
      };
    }
    return { vaultId, updatedAt: now, entries };
  }

  async getContent(vaultId: string, path: string): Promise<VaultContentResult | null> {
    await this.ensureYjsMigrated(vaultId);
    const doc = this.yjs.getDoc();
    const { paths } = getVaultMaps(doc);
    const fileId = paths.get(path.toLowerCase());
    if (!fileId) return null;

    const active = listActiveFiles(doc).find((f) => f.fileId === fileId);
    if (!active) return null;

    if (active.kind === "text") {
      const text = getTextContent(doc, fileId) ?? "";
      const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
      return { path: active.path, contentType: active.contentType, revision: 1, bytes };
    }

    const obj = await this.env.VAULT_BUCKET.get(contentKey(vaultId, active.path));
    if (!obj) return null;
    return {
      path: active.path,
      contentType: obj.httpMetadata?.contentType ?? active.contentType,
      revision: 1,
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
    return this.applyPut(vaultId, path, body, contentType);
  }

  async syncPutFile(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    author = "device"
  ): Promise<WriteResult> {
    return this.applyPut(vaultId, path, body, contentType, author);
  }

  async renameFile(vaultId: string, oldPath: string, newPath: string, _author = "web"): Promise<ManifestEntry> {
    await this.ensureYjsMigrated(vaultId);
    if (!isValidVaultPath(oldPath) || !isValidVaultPath(newPath)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }
    if (isVaultInternal(newPath)) {
      throw Object.assign(new Error("Cannot move to vault internals"), { status: 400 });
    }
    if (oldPath === newPath) {
      throw Object.assign(new Error("Source and destination are the same"), { status: 400 });
    }

    const doc = this.yjs.getDoc();
    const { paths } = getVaultMaps(doc);
    const fileId = paths.get(oldPath.toLowerCase());
    if (!fileId) throw Object.assign(new Error("Source not found"), { status: 404 });
    if (paths.get(newPath.toLowerCase())) {
      throw Object.assign(new Error("Destination exists"), { status: 409 });
    }

    yjsRenameFile(doc, fileId, newPath);

    const files = this.yjs.manifest();
    const f = files.find((x) => x.fileId === fileId);
    this.markDirty(newPath, false);
    await this.ensureSealScheduled();
    await this.armAlarm();
    return {
      path: newPath,
      r2Key: f?.r2Key ?? contentKey(vaultId, newPath),
      size: f?.size ?? 0,
      contentType: f?.contentType ?? "text/plain",
      updatedAt: new Date().toISOString(),
      revision: 1,
    };
  }

  async syncRenameFile(vaultId: string, oldPath: string, newPath: string, author = "device"): Promise<ManifestEntry> {
    return this.renameFile(vaultId, oldPath, newPath, author);
  }

  async deleteFile(vaultId: string, path: string, _author = "web"): Promise<void> {
    await this.ensureYjsMigrated(vaultId);
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    const doc = this.yjs.getDoc();
    const { paths } = getVaultMaps(doc);
    const fileId = paths.get(path.toLowerCase());
    if (!fileId) return;
    yjsSoftDelete(doc, fileId);
    this.markDirty(path, true);
    await this.ensureSealScheduled();
    await this.armAlarm();
  }

  async syncDeleteFile(vaultId: string, path: string, author = "device"): Promise<void> {
    return this.deleteFile(vaultId, path, author);
  }

  async flushToR2(vaultId?: string): Promise<void> {
    const meta = vaultId ? null : await this.getMeta();
    const id = vaultId ?? meta?.id;
    if (!id) return;
    await this.ensureYjsMigrated(id);

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

      if (kind === "delete") {
        await this.env.VAULT_BUCKET.delete(contentKey(id, path));
        removeFromIndex(this.env.DB, id, path).catch(() => {});
        continue;
      }

      const rename = keyRows.find((row) => String(row.kind) === "rename");
      if (rename) {
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
    }

    this.sql.exec(`DELETE FROM pending_ops`);
    await this.writeManifestToR2(id);
    await this.clearState("flush_deadline");
  }

  async sealNow(label?: string): Promise<{ commitHash?: string; fileCount: number; remote?: string }> {
    const meta = await this.getMeta();
    if (!meta) throw Object.assign(new Error("Vault not found"), { status: 404 });
    await this.flushToR2(meta.id);

    const gitConfig = await getGitRemote(this.env.DB, meta.id);
    if (!gitConfig || !this.env.GITHUB_PAT_ENCRYPTION_KEY) {
      // No GitHub remote — nothing to seal. Drop dirty markers so we don't keep retrying.
      this.sql.exec(`DELETE FROM seal_dirty`);
      await this.clearState("seal_deadline");
      await this.armAlarm();
      return { fileCount: 0 };
    }

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
        applyMerged: async (path, content, author) =>
          this.applyPut(
            meta.id,
            path,
            new TextEncoder().encode(content).buffer as ArrayBuffer,
            "text/markdown",
            author
          ),
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

    const changes = this.dirtyChanges();
    if (changes.length === 0) {
      await this.clearState("seal_deadline");
      await this.armAlarm();
      return { fileCount: 0, remote: gitConfig.repoUrl };
    }

    try {
      const remote = await createGitHubRemote(
        {
          repoUrl: gitConfig.repoUrl,
          branch: gitConfig.branch,
          subdir: gitConfig.subdir,
          patCiphertext: gitConfig.patCiphertext,
        },
        this.env.GITHUB_PAT_ENCRYPTION_KEY
      );
      const result = await sealToRemote(
        remote,
        meta.id,
        changes,
        async (path) => {
          const content = await this.getContent(meta.id, path);
          return content ? content.bytes : null;
        },
        label
      );
      await updateGitRemoteState(this.env.DB, meta.id, {
        syncState: "idle",
        lastSyncedCommit: result.commitHash || gitConfig.lastSyncedCommit,
        lastSyncedAt: new Date().toISOString(),
      });

      this.sql.exec(`DELETE FROM seal_dirty`);
      await this.setState("last_seal_at", String(Date.now()));
      if (this.dirtyChanges().length > 0) {
        await this.scheduleNextSeal();
      } else {
        await this.clearState("seal_deadline");
        await this.armAlarm();
      }
      return result;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "NON_FAST_FORWARD") {
        await updateGitRemoteState(this.env.DB, meta.id, { syncState: "conflict" });
      }
      throw err;
    }
  }

  async alarm(): Promise<void> {
    this.yjs.maybeRunDebounced();

    const meta = await this.getMeta();
    if (!meta) return;

    const now = Date.now();
    const flushDeadline = this.numberState("flush_deadline");
    const sealDeadline = this.numberState("seal_deadline");

    if (flushDeadline !== null && flushDeadline <= now) {
      await this.flushToR2(meta.id);
    }

    if (sealDeadline !== null && sealDeadline <= now) {
      const dirty = this.dirtyChanges();
      if (dirty.length === 0) {
        await this.clearState("seal_deadline");
      } else {
        try {
          const result = await this.sealNow();
          if (result.fileCount > 0 && result.commitHash) {
            console.log(
              `[lapis] Sealed vault ${meta.id}: ${result.commitHash} (${result.fileCount} files)`
            );
          }
        } catch (err) {
          const e = err as Error;
          console.error(
            `[lapis] Seal failed for vault ${meta.id}: ${e?.message ?? err}`,
            e?.stack ?? ""
          );
          await this.scheduleNextSeal();
        }
      }
    }

    await this.armAlarm();
  }

  async getLog(limit = 50): Promise<SealedCommit[]> {
    const meta = await this.getMeta();
    if (!meta) return [];
    const gitConfig = await getGitRemote(this.env.DB, meta.id);
    if (!gitConfig || !this.env.GITHUB_PAT_ENCRYPTION_KEY) return [];
    try {
      const remote = await createGitHubRemote(
        {
          repoUrl: gitConfig.repoUrl,
          branch: gitConfig.branch,
          subdir: gitConfig.subdir,
          patCiphertext: gitConfig.patCiphertext,
        },
        this.env.GITHUB_PAT_ENCRYPTION_KEY
      );
      return getRemoteLog(remote, limit);
    } catch {
      return [];
    }
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
    // Yjs binary frames
    if (typeof message !== "string") {
      this.yjs.handleMessage(ws, message);
      return;
    }

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
    if (url.pathname === "/yjs" && request.method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const canWrite = url.searchParams.get("write") === "1";
      const vaultId = url.searchParams.get("vaultId");
      if (vaultId) await this.ensureYjsMigrated(vaultId);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, ["yjs"]);
      this.yjs.acceptClient(server, canWrite);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/ws" && request.method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
      const identity = url.searchParams.get("identity") ?? "unknown";
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, ["presence"]);
      this.setPresence(server, { identity, openPath: null });
      server.send(JSON.stringify(this.presenceSnapshot()));
      this.broadcast(this.presenceSnapshot());
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  /** One-shot: load legacy R2 text into Y.Doc when storage_version < 2. */
  async ensureYjsMigrated(vaultId: string): Promise<void> {
    const version = this.stringState("storage_version");
    if (version === "2") {
      this.yjs.ensureDoc();
      return;
    }

    this.yjs.ensureDoc();
    const doc = this.yjs.getDoc();
    if (listActiveFiles(doc).length > 0) {
      await this.setState("storage_version", "2");
      return;
    }

    // Migrate from R2 manifest if present
    await this.ensureManifestLoaded(vaultId);
    const manifest = this.manifestFromSql(vaultId);
    for (const entry of Object.values(manifest.entries)) {
      if (isVaultInternal(entry.path)) continue;
      if (isTextContentType(entry.contentType)) {
        const obj = await this.env.VAULT_BUCKET.get(entry.r2Key);
        if (!obj) continue;
        const text = await obj.text();
        setTextFile(doc, {
          path: entry.path,
          content: text,
          contentType: entry.contentType,
        });
      } else {
        setBinaryMeta(doc, {
          path: entry.path,
          r2Key: entry.r2Key,
          hash: "",
          size: entry.size,
          contentType: entry.contentType,
        });
      }
    }
    this.yjs.compact();
    await this.setState("storage_version", "2");
  }

  private async reindexFromYjs(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const doc = this.yjs.getDoc();
    const files = listActiveFiles(doc);
    const vaultPaths = files.map((f) => f.path);
    for (const file of files) {
      if (isVaultInternal(file.path)) continue;
      if (file.kind === "text") {
        const text = getTextContent(doc, file.fileId) ?? "";
        await indexFile(this.env.DB, {
          vaultId: meta.id,
          path: file.path,
          content: text,
          vaultPaths,
        });
      }
    }
  }

  private stringState(key: string): string | null {
    const row = this.sql
      .exec<{ value: SqlStorageValue }>(`SELECT value FROM do_state WHERE key = ?`, key)
      .toArray()[0];
    return row ? String(row.value) : null;
  }

  private async applyPut(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    author = "web"
  ): Promise<WriteResult> {
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(path)) throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });

    await this.ensureYjsMigrated(vaultId);
    const doc = this.yjs.getDoc();
    const now = new Date().toISOString();

    if (isTextContentType(contentType)) {
      const modified = new TextDecoder().decode(body);
      const { paths } = getVaultMaps(doc);
      const existingId = paths.get(path.toLowerCase());
      setTextFile(doc, {
        fileId: existingId,
        path,
        content: modified,
        contentType,
      });
      const bytes = new TextEncoder().encode(modified).byteLength;
      const entry: WriteResult = {
        path,
        r2Key: contentKey(vaultId, path),
        size: bytes,
        contentType,
        updatedAt: now,
        revision: 1,
      };
      this.markDirty(path, false);
      await this.ensureSealScheduled();
      await this.armAlarm();
      return entry;
    }

    await this.env.VAULT_BUCKET.put(contentKey(vaultId, path), body, {
      httpMetadata: { contentType },
    });
    const { paths } = getVaultMaps(doc);
    const existingId = paths.get(path.toLowerCase());
    const hashBuf = await crypto.subtle.digest("SHA-256", body);
    const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    setBinaryMeta(doc, {
      fileId: existingId,
      path,
      r2Key: contentKey(vaultId, path),
      hash,
      size: body.byteLength,
      contentType,
    });
    const entry: WriteResult = {
      path,
      r2Key: contentKey(vaultId, path),
      size: body.byteLength,
      contentType,
      updatedAt: now,
      revision: 1,
    };
    this.markDirty(path, false);
    await this.ensureSealScheduled();
    await this.armAlarm();
    return entry;
  }

  private async ensureManifestLoaded(vaultId: string): Promise<void> {
    const existing = this.sql.exec(`SELECT path_lower FROM manifest_entries LIMIT 1`).toArray();
    if (existing.length > 0) return;
    const obj = await this.env.VAULT_BUCKET.get(manifestKey(vaultId));
    if (!obj) return;
    const manifest = (await obj.json()) as VaultManifest;
    for (const entry of Object.values(manifest.entries)) {
      this.upsertEntry(entry, entry.revision);
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
    this.yjs.ensureDoc();
    const vaultId = this.metaVaultId();
    const file = this.yjs.manifest().find((f) => f.path.toLowerCase() === lowerPath(path));
    if (file) {
      return {
        path: file.path,
        r2Key: file.r2Key ?? contentKey(vaultId, file.path),
        size: file.size,
        contentType: file.contentType,
        updatedAt: new Date().toISOString(),
        revision: 1,
        r2Revision: 1,
      };
    }

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

  private async headText(vaultId: string, path: string): Promise<string> {
    await this.ensureYjsMigrated(vaultId);
    const doc = this.yjs.getDoc();
    const { paths } = getVaultMaps(doc);
    const fileId = paths.get(path.toLowerCase());
    if (!fileId) return "";
    return getTextContent(doc, fileId) ?? "";
  }

  private markDirty(path: string, deleted: boolean): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO seal_dirty (path_lower, path, deleted) VALUES (?, ?, ?)`,
      lowerPath(path),
      path,
      deleted ? 1 : 0
    );
    if (this.numberState("seal_deadline") === null) {
      this.sql.exec(
        `INSERT OR REPLACE INTO do_state (key, value) VALUES (?, ?)`,
        "seal_deadline",
        String(Date.now() + DEFAULT_SEAL_INTERVAL_MS)
      );
    }
  }

  private markYjsDirtyForSeal(): void {
    const doc = this.yjs.getDoc();
    for (const file of listActiveFiles(doc)) {
      if (isVaultInternal(file.path)) continue;
      this.markDirty(file.path, false);
    }
  }

  private dirtyChanges(): IncrementalSealChange[] {
    return this.sql.exec<DirtyRow>(
      `SELECT path_lower AS pathLower, path, deleted FROM seal_dirty ORDER BY path`
    ).toArray().map((row) => ({ path: String(row.path), deleted: Number(row.deleted) === 1 }));
  }

  private async writeManifestToR2(vaultId: string): Promise<void> {
    const manifest = await this.getManifest(vaultId);
    await this.env.VAULT_BUCKET.put(manifestKey(vaultId), JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  private async writeConflictNote(vaultId: string, ctx: ConflictContext, author: string): Promise<string> {
    const notePath = conflictNotePath(ctx);
    const body = renderConflictNote(ctx);
    await this.applyPut(
      vaultId,
      notePath,
      new TextEncoder().encode(body).buffer as ArrayBuffer,
      "text/markdown",
      author
    );
    return notePath;
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

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("svg");
}
