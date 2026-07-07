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
import { applyPatch } from "./patch";
import { indexFile, removeFromIndex } from "../search/indexer";
import {
  getVaultLog,
  sealVault,
  type IncrementalSealChange,
  type SealedCommit,
} from "../artifacts/sealer";

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

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_SEAL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_FLUSH_MAX_PENDING = 250;

export class VaultCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly presence = new Map<WebSocket, PresenceEntry>();
  private readonly headContent = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
    await this.ensureSealScheduled();
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
    author = "device"
  ): Promise<ManifestEntry> {
    return this.applyPut(vaultId, path, body, contentType, baseRevision, author);
  }

  async syncApplyPatch(
    vaultId: string,
    path: string,
    patch: string,
    baseRevision: number,
    author = "device"
  ): Promise<ManifestEntry> {
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(path)) throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });

    await this.ensureManifestLoaded(vaultId);
    const entry = this.getEntry(path);
    if (!entry) throw Object.assign(new Error("File not found"), { status: 404 });
    this.assertBaseRevision(entry, baseRevision);

    const original = await this.headText(vaultId, entry.path);
    const patched = applyPatch(original, patch);
    if (patched === null) throw Object.assign(new Error("Patch does not apply cleanly"), { status: 422 });

    const encoded = new TextEncoder().encode(patched);
    const next = this.bumpEntry(entry.path, encoded.byteLength, entry.contentType);
    this.headContent.set(lowerPath(entry.path), patched);
    this.appendPending({
      path: entry.path,
      kind: "patch",
      patch,
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
      patch,
      author,
      ts: next.updatedAt,
    });
    return next;
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

    // Fold any existing text changes first so the deferred rename has a stable R2 source.
    await this.flushPathToR2(vaultId, oldEntry.path);

    const next: ManifestEntry = {
      ...oldEntry,
      path: newPath,
      r2Key: contentKey(vaultId, newPath),
      updatedAt: new Date().toISOString(),
      revision: oldEntry.revision + 1,
    };
    this.deleteEntry(oldEntry.path);
    this.upsertEntry(next, oldEntry.revision);
    this.headContent.delete(lowerPath(oldEntry.path));
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
    await this.flushPathToR2(vaultId, entry.path);

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

      const entry = this.getEntry(path);
      if (!entry) continue;
      if (isTextContentType(entry.contentType)) {
        const text = await this.headText(id, entry.path);
        const bytes = new TextEncoder().encode(text);
        await this.env.VAULT_BUCKET.put(contentKey(id, entry.path), bytes, {
          httpMetadata: { contentType: entry.contentType },
        });
        this.setR2Revision(entry.path, entry.revision);
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

    const changes = this.dirtyChanges();
    if (changes.length === 0 && meta.artifactsRemote) {
      await this.scheduleNextSeal();
      return { fileCount: 0, remote: meta.artifactsRemote };
    }

    const result = await sealVault(
      this.env.ARTIFACTS,
      meta.id,
      changes,
      meta.artifactsRemote ?? null,
      async (path) => {
        const obj = await this.env.VAULT_BUCKET.get(contentKey(meta.id, path));
        return obj ? obj.arrayBuffer() : null;
      },
      label
    );
    if (!meta.artifactsRemote || meta.artifactsRemote !== result.remote) this.setArtifactsRemote(result.remote);
    this.sql.exec(`DELETE FROM seal_dirty`);
    await this.setState("last_seal_at", String(Date.now()));
    await this.scheduleNextSeal();
    return result;
  }

  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    const now = Date.now();
    const flushDeadline = this.numberState("flush_deadline");
    const sealDeadline = this.numberState("seal_deadline");

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

  private async applyPut(vaultId: string, path: string, body: ArrayBuffer, contentType: string, baseRevision: number | undefined, author: string): Promise<ManifestEntry> {
    if (!isValidVaultPath(path)) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isVaultInternal(path)) throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });
    await this.ensureManifestLoaded(vaultId);

    const existing = this.getEntry(path);
    if (baseRevision !== undefined && existing) this.assertBaseRevision(existing, baseRevision);
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
      this.upsertEntry(entry, nextRevision);
      this.markDirty(path, false);
      await this.scheduleFlush();
      this.broadcast({ type: "change", path, kind: "put", baseRevision: previousRevision, revision: nextRevision, author, ts: now });
      return entry;
    }

    const original = existing ? await this.headText(vaultId, existing.path) : "";
    const modified = new TextDecoder().decode(body);
    const patch = createLinePatch(path, original, modified);
    this.upsertEntry(entry, existing?.r2Revision ?? 0);
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
    const text = await this.materializeText(vaultId, path);
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
