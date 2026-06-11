import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  type VaultManifest,
  type ManifestEntry,
  emptyManifest,
  hasCaseDuplicate,
  manifestKey,
  contentKey,
  isAncestorPath,
} from "./manifest";
import { isValidVaultPath, isVaultInternal } from "./path";
import { applyPatch, merge3 } from "./patch";
import { conflictNotePath, renderConflictNote } from "./conflict";

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

/**
 * VaultCoordinator — one Durable Object instance per vault (keyed by vault ID).
 *
 * Responsibilities (Slice 01):
 *   - Store durable vault metadata in SQLite storage.
 *   - Serialize concurrent mutations (enforced by the single-threaded DO).
 *
 * Slice 02 additions:
 *   - R2 manifest management: getManifest, putFile, deleteFile
 *
 * Slice 09 additions:
 *   - Revision tracking on ManifestEntry (monotonic per-file counter)
 *   - syncPutFile: whole-object upload with optional base-revision check
 *   - syncApplyPatch: apply a unified diff if base revision matches
 *   - syncRenameFile: rename via device sync (same guards as web)
 *   - syncDeleteFile: delete via device sync
 *
 * Slice 10 additions:
 *   - Hibernatable WebSocket support via fetch() /ws endpoint
 *   - broadcast(message): fan-out change notifications to all connected clients
 *   - Presence tracking: open-file awareness via {"type":"open","path":"..."} messages
 *   - webSocketMessage / webSocketClose handlers
 */

/**
 * Notification message broadcast to all connected WebSocket clients.
 * Small payload — clients re-fetch changed content via authenticated APIs.
 */
export interface ChangeNotification {
  type: "change";
  path: string;
  kind: "put" | "rename" | "delete";
  revision?: number;
  newPath?: string; // only present for kind=rename
  ts: string;      // ISO timestamp
}

/** Presence notification sent to all clients when someone connects/disconnects. */
export interface PresenceNotification {
  type: "presence";
  sessions: Array<{ identity: string; openPath: string | null }>;
}

/** Same-file warning sent to a newly-connecting client. */
export interface SameFileWarning {
  type: "same_file_warning";
  path: string;
  others: string[]; // identities of other clients with this file open
}

type ServerMessage = ChangeNotification | PresenceNotification | SameFileWarning;

/** Per-connection presence metadata (ephemeral, in memory). */
interface PresenceEntry {
  identity: string;
  openPath: string | null;
}
export class VaultCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Ephemeral presence map — keyed by WebSocket object identity. */
  private readonly presence = new Map<WebSocket, PresenceEntry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `);
  }

  /** Initialize vault metadata on first creation. Idempotent. */
  async initialize(meta: VaultMeta): Promise<void> {
    this.sql.exec(
      `INSERT OR IGNORE INTO vault_meta (id, owner_id, name, created_at)
       VALUES (?, ?, ?, ?)`,
      meta.id,
      meta.ownerId,
      meta.name,
      meta.createdAt
    );
  }

  /** Return stored metadata, or null if not yet initialized. */
  async getMeta(): Promise<VaultMeta | null> {
    const cursor = this.sql.exec<VaultMetaRow>(
      `SELECT id, owner_id AS ownerId, name, created_at AS createdAt
       FROM vault_meta LIMIT 1`
    );
    const rows = cursor.toArray();
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      id: String(row.id),
      ownerId: String(row.ownerId),
      name: String(row.name),
      createdAt: String(row.createdAt),
    };
  }

  // ── Manifest operations ────────────────────────────────────────────────────

  private async readManifest(vaultId: string): Promise<VaultManifest> {
    const obj = await this.env.VAULT_BUCKET.get(manifestKey(vaultId));
    if (!obj) return emptyManifest(vaultId);
    return (await obj.json()) as VaultManifest;
  }

  private async writeManifest(manifest: VaultManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await this.env.VAULT_BUCKET.put(
      manifestKey(manifest.vaultId),
      JSON.stringify(manifest),
      { httpMetadata: { contentType: "application/json" } }
    );
  }

  /**
   * Return the current manifest for a vault.
   * Called by GET /api/vaults/:id/manifest.
   */
  async getManifest(vaultId: string): Promise<VaultManifest> {
    return this.readManifest(vaultId);
  }

  /**
   * Store a new file revision in R2 and update the manifest.
   * Enforces path validation and case-duplicate prevention.
   *
   * Returns the updated ManifestEntry on success, or throws with {status, message}.
   */
  async putFile(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string
  ): Promise<ManifestEntry> {
    if (!isValidVaultPath(path)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }
    if (isVaultInternal(path)) {
      throw Object.assign(new Error("Cannot write to vault internals"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);

    if (hasCaseDuplicate(manifest, path)) {
      throw Object.assign(
        new Error(`Case conflict: a file with a similar name already exists`),
        { status: 409 }
      );
    }

    const r2Key = contentKey(vaultId, path);
    await this.env.VAULT_BUCKET.put(r2Key, body, {
      httpMetadata: { contentType },
    });

    const existing = manifest.entries[path.toLowerCase()];
    const revision = (existing?.revision ?? 0) + 1;

    const entry: ManifestEntry = {
      path,
      r2Key,
      size: body.byteLength,
      contentType,
      updatedAt: new Date().toISOString(),
      revision,
    };

    manifest.entries[path.toLowerCase()] = entry;
    await this.writeManifest(manifest);

    // Notify all connected clients
    this.broadcast({ type: "change", path, kind: "put", revision: entry.revision, ts: entry.updatedAt });

    return entry;
  }

  /**
   * Rename (or move) a file — copy R2 object to new key, update manifest,
   * delete old R2 object. Atomic within the DO.
   *
   * Throws 400 if either path is invalid, 404 if source not found,
   * 409 if destination has a case duplicate.
   */
  async renameFile(
    vaultId: string,
    oldPath: string,
    newPath: string
  ): Promise<ManifestEntry> {
    if (!isValidVaultPath(oldPath) || !isValidVaultPath(newPath)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }
    if (isVaultInternal(newPath)) {
      throw Object.assign(new Error("Cannot move to vault internals"), { status: 400 });
    }
    if (oldPath === newPath) {
      throw Object.assign(new Error("Source and destination are the same"), { status: 400 });
    }
    if (isAncestorPath(oldPath, newPath)) {
      throw Object.assign(new Error("Cannot move a folder into itself"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);
    const oldEntry = manifest.entries[oldPath.toLowerCase()];
    if (!oldEntry) {
      throw Object.assign(new Error("Source not found"), { status: 404 });
    }

    // Check case-duplicate at destination (excluding the existing source entry)
    if (hasCaseDuplicate(manifest, newPath, oldPath)) {
      throw Object.assign(
        new Error("Case conflict at destination"),
        { status: 409 }
      );
    }

    // Copy R2 object
    const srcKey = contentKey(vaultId, oldPath);
    const destKey = contentKey(vaultId, newPath);
    const obj = await this.env.VAULT_BUCKET.get(srcKey);
    if (!obj) {
      // R2 and manifest are out of sync — clean up and report 404
      delete manifest.entries[oldPath.toLowerCase()];
      await this.writeManifest(manifest);
      throw Object.assign(new Error("Source not found in storage"), { status: 404 });
    }

    await this.env.VAULT_BUCKET.put(destKey, await obj.arrayBuffer(), {
      httpMetadata: { contentType: oldEntry.contentType },
    });

    // Update manifest
    const newEntry: ManifestEntry = {
      ...oldEntry,
      path: newPath,
      r2Key: destKey,
      updatedAt: new Date().toISOString(),
      revision: (oldEntry.revision ?? 0) + 1,
    };
    manifest.entries[newPath.toLowerCase()] = newEntry;
    delete manifest.entries[oldPath.toLowerCase()];
    await this.writeManifest(manifest);

    // Delete old R2 object
    await this.env.VAULT_BUCKET.delete(srcKey);

    // Notify connected clients
    this.broadcast({
      type: "change",
      path: oldPath,
      kind: "rename",
      revision: newEntry.revision,
      newPath,
      ts: newEntry.updatedAt,
    });

    return newEntry;
  }

  /**
   * Delete a file from R2 and remove it from the manifest.
   * No-ops silently if the path is not in the manifest.
   */
  async deleteFile(vaultId: string, path: string): Promise<void> {
    if (!isValidVaultPath(path)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);
    const lower = path.toLowerCase();
    const entry = manifest.entries[lower];
    if (!entry) return; // already gone — idempotent

    await this.env.VAULT_BUCKET.delete(entry.r2Key);
    delete manifest.entries[lower];
    await this.writeManifest(manifest);

    // Notify connected clients
    this.broadcast({ type: "change", path, kind: "delete", ts: new Date().toISOString() });
  }

  // ── Sync protocol methods (Slice 09) ──────────────────────────────────────

  /**
   * Whole-object upload from a plugin device.
   *
   * If `baseRevision` is provided:
   *   - If the server's current revision matches, proceed.
   *   - If not, throw 409 (stale — Slice 11 will add three-way merge).
   * If `baseRevision` is omitted (e.g., for new files), accept unconditionally.
   *
   * Returns the new ManifestEntry on success.
   */
  async syncPutFile(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    baseRevision?: number
  ): Promise<ManifestEntry> {
    if (!isValidVaultPath(path)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);
    const lower = path.toLowerCase();
    const existing = manifest.entries[lower];

    // Staleness check
    if (baseRevision !== undefined && existing) {
      const serverRevision = existing.revision ?? 0;
      if (serverRevision !== baseRevision) {
        throw Object.assign(
          new Error(`Revision conflict: server has ${serverRevision}, client base is ${baseRevision}`),
          { status: 409, serverRevision }
        );
      }
    }

    if (hasCaseDuplicate(manifest, path)) {
      throw Object.assign(
        new Error("Case conflict: a file with a similar name already exists"),
        { status: 409 }
      );
    }

    const r2Key = contentKey(vaultId, path);
    await this.env.VAULT_BUCKET.put(r2Key, body, {
      httpMetadata: { contentType },
    });

    const entry: ManifestEntry = {
      path,
      r2Key,
      size: body.byteLength,
      contentType,
      updatedAt: new Date().toISOString(),
      revision: (existing?.revision ?? 0) + 1,
    };

    manifest.entries[lower] = entry;
    await this.writeManifest(manifest);

    // Notify connected clients
    this.broadcast({ type: "change", path, kind: "put", revision: entry.revision, ts: entry.updatedAt });

    return entry;
  }

  /**
   * Apply a unified diff patch to a text file.
   *
   * The patch must be a standard unified diff string (--- a/... +++ b/... hunks).
   * `baseRevision` MUST match the server's current revision; if not, throws 409.
   * On success, writes the patched content to R2 and returns the updated entry.
   */
  async syncApplyPatch(
    vaultId: string,
    path: string,
    patch: string,
    baseRevision: number
  ): Promise<ManifestEntry> {
    if (!isValidVaultPath(path)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);
    const lower = path.toLowerCase();
    const existing = manifest.entries[lower];

    if (!existing) {
      throw Object.assign(new Error("File not found"), { status: 404 });
    }

    const serverRevision = existing.revision ?? 0;
    if (serverRevision !== baseRevision) {
      throw Object.assign(
        new Error(`Revision conflict: server has ${serverRevision}, client base is ${baseRevision}`),
        { status: 409, serverRevision }
      );
    }

    // Fetch current content
    const r2Key = contentKey(vaultId, path);
    const obj = await this.env.VAULT_BUCKET.get(r2Key);
    if (!obj) {
      throw Object.assign(new Error("File content missing from storage"), { status: 500 });
    }
    const original = await obj.text();

    // Apply the unified diff
    const patched = applyPatch(original, patch);
    if (patched === null) {
      throw Object.assign(new Error("Patch does not apply cleanly"), { status: 422 });
    }

    const encoded = new TextEncoder().encode(patched);
    await this.env.VAULT_BUCKET.put(r2Key, encoded, {
      httpMetadata: { contentType: existing.contentType },
    });

    const entry: ManifestEntry = {
      ...existing,
      size: encoded.byteLength,
      updatedAt: new Date().toISOString(),
      revision: serverRevision + 1,
    };

    manifest.entries[lower] = entry;
    await this.writeManifest(manifest);

    // Notify connected clients
    this.broadcast({ type: "change", path, kind: "put", revision: entry.revision, ts: entry.updatedAt });

    return entry;
  }

  /**
   * Rename/move a file via the sync protocol.
   * Same guards as `renameFile` but called from a device context.
   */
  async syncRenameFile(
    vaultId: string,
    oldPath: string,
    newPath: string
  ): Promise<ManifestEntry> {
    return this.renameFile(vaultId, oldPath, newPath);
  }

  /**
   * Delete a file via the sync protocol.
   * Same as `deleteFile` but called from a device context.
   */
  async syncDeleteFile(vaultId: string, path: string): Promise<void> {
    return this.deleteFile(vaultId, path);
  }

  // ── Conflict/merge methods (Slice 11) ─────────────────────────────────────

  /**
   * Handle a stale whole-object upload from a device.
   *
   * For text files: we have the server's current content (`ours`) and the
   * client's full content (`theirs`) but not the common ancestor (`base`).
   * Without base we cannot perform a proper three-way merge, so we always
   * create a Conflict Note and preserve the server version.
   *
   * For binary files: same treatment — Conflict Note, server preserved.
   *
   * Returns the ManifestEntry of the newly-created Conflict Note.
   */
  async syncConflictWholeObject(
    vaultId: string,
    path: string,
    body: ArrayBuffer,
    contentType: string,
    serverRevision: number,
    clientBaseRevision: number,
    deviceName: string
  ): Promise<{ conflictPath: string; entry: ManifestEntry }> {
    const timestamp = new Date().toISOString();
    const isBinary = !contentType.startsWith("text/") && contentType !== "application/json";

    // Fetch current server content (text only)
    let serverContent: string | undefined;
    if (!isBinary) {
      const r2Key = contentKey(vaultId, path);
      const obj = await this.env.VAULT_BUCKET.get(r2Key);
      if (obj) serverContent = await obj.text();
    }

    const clientContent = isBinary ? undefined : new TextDecoder().decode(body);

    const ctx = {
      path,
      serverContent,
      clientContent,
      serverRevision,
      clientBaseRevision,
      deviceName,
      timestamp,
      isBinary,
    };

    const notePath = conflictNotePath(ctx);
    const noteBody = renderConflictNote(ctx);
    const encoded = new TextEncoder().encode(noteBody);

    const entry = await this.putFile(vaultId, notePath, encoded.buffer as ArrayBuffer, "text/markdown");
    return { conflictPath: notePath, entry };
  }

  /**
   * Handle a stale text patch from a device by attempting a three-way merge.
   *
   * Requires the client to provide its full intended content (`clientContent`)
   * so we can perform merge3(base, ours, theirs) even though we don't store
   * the base content.
   *
   * We reconstruct `base` by reverse-engineering: `base` = the server content
   * at `clientBaseRevision`. Since we don't store history, we approximate base
   * as the server content with the patch reversed, which we do by using
   * `clientContent` and the known server content directly with merge3 — treating
   * the patch as the client's explicit intent.
   *
   * In practice: we call merge3(base="", ours=serverContent, theirs=clientContent)
   * where we derive base from the patch metadata. If `baseContent` is supplied
   * by the caller (optional — requires client to send it), we use it directly.
   * Otherwise we attempt to merge ours and theirs with an empty base (which means
   * any region changed by only one side wins, same-change regions are accepted,
   * and conflicting regions get markers).
   *
   * Clean merge → accepted as new revision.
   * Conflicting merge → Conflict Note created, original preserved.
   *
   * Returns either the merged ManifestEntry or the Conflict Note path/entry.
   */
  async syncMergePatch(
    vaultId: string,
    path: string,
    patch: string,
    serverRevision: number,
    clientBaseRevision: number,
    deviceName: string,
    clientContent: string,
    baseContent?: string
  ): Promise<
    | { kind: "merged"; entry: ManifestEntry }
    | { kind: "conflict"; conflictPath: string; entry: ManifestEntry }
  > {
    if (!isValidVaultPath(path)) {
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    }

    const manifest = await this.readManifest(vaultId);
    const lower = path.toLowerCase();
    const existing = manifest.entries[lower];
    if (!existing) {
      throw Object.assign(new Error("File not found"), { status: 404 });
    }

    // Fetch current server content
    const r2Key = contentKey(vaultId, path);
    const obj = await this.env.VAULT_BUCKET.get(r2Key);
    if (!obj) {
      throw Object.assign(new Error("File content missing from storage"), { status: 500 });
    }
    const ours = await obj.text();

    // base: use provided baseContent, otherwise attempt to extract from patch
    // by applying the patch to clientContent in reverse. For simplicity, if
    // baseContent is not provided, use empty string so merge3 treats each
    // non-overlapping change as the winning side.
    const base = baseContent ?? "";

    const { merged, hasConflicts } = merge3(base, ours, clientContent);

    if (!hasConflicts) {
      // Clean three-way merge — write result as new revision
      const encoded = new TextEncoder().encode(merged);
      const entry: ManifestEntry = {
        ...existing,
        size: encoded.byteLength,
        updatedAt: new Date().toISOString(),
        revision: serverRevision + 1,
      };
      await this.env.VAULT_BUCKET.put(r2Key, encoded.buffer as ArrayBuffer, {
        httpMetadata: { contentType: existing.contentType },
      });
      manifest.entries[lower] = entry;
      await this.writeManifest(manifest);
      this.broadcast({ type: "change", path, kind: "put", revision: entry.revision, ts: entry.updatedAt });
      return { kind: "merged", entry };
    }

    // Unsafe merge — create Conflict Note
    const timestamp = new Date().toISOString();
    const ctx = {
      path,
      serverContent: ours,
      clientContent,
      baseContent: baseContent,
      serverRevision,
      clientBaseRevision,
      deviceName,
      timestamp,
      isBinary: false,
    };
    const notePath = conflictNotePath(ctx);
    const noteBody = renderConflictNote(ctx);
    const encoded = new TextEncoder().encode(noteBody);
    const noteEntry = await this.putFile(vaultId, notePath, encoded.buffer as ArrayBuffer, "text/markdown");
    return { kind: "conflict", conflictPath: notePath, entry: noteEntry };
  }

  // ── WebSocket / Presence methods (Slice 10) ───────────────────────────────

  /**
   * Broadcast a message to all connected WebSocket clients.
   * Called after every accepted file mutation.
   */
  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — remove from presence
        this.presence.delete(ws);
      }
    }
  }

  /** Build the current presence snapshot for all connected clients. */
  private presenceSnapshot(): PresenceNotification {
    const sessions: PresenceNotification["sessions"] = [];
    for (const [, entry] of this.presence) {
      sessions.push({ identity: entry.identity, openPath: entry.openPath });
    }
    return { type: "presence", sessions };
  }

  /** Send a message to a single WebSocket. */
  private sendTo(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch { /* ignore */ }
  }

  // ── DurableObject WebSocket lifecycle handlers ─────────────────────────────

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return; // ignore invalid JSON
    }

    // {"type": "open", "path": "notes/foo.md"}
    if (parsed.type === "open") {
      const path = typeof parsed.path === "string" ? parsed.path : null;
      const entry = this.presence.get(ws);
      if (entry) {
        entry.openPath = path;
      }

      // Warn if other clients have the same file open
      if (path) {
        const others: string[] = [];
        for (const [otherWs, otherEntry] of this.presence) {
          if (otherWs !== ws && otherEntry.openPath === path) {
            others.push(otherEntry.identity);
          }
        }
        if (others.length > 0) {
          this.sendTo(ws, { type: "same_file_warning", path, others });
        }
      }

      // Broadcast updated presence to all clients
      this.broadcast(this.presenceSnapshot());
    }

    // {"type": "close_file"}
    if (parsed.type === "close_file") {
      const entry = this.presence.get(ws);
      if (entry) entry.openPath = null;
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

  /** Handle HTTP requests forwarded from the main Worker. */
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

    // WebSocket upgrade endpoint
    // URL: /ws?identity=<session-or-device-id>
    if (url.pathname === "/ws" && request.method === "GET") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const identity = url.searchParams.get("identity") ?? "unknown";
      const { 0: client, 1: server } = new WebSocketPair();

      this.ctx.acceptWebSocket(server);
      this.presence.set(server, { identity, openPath: null });

      // Send initial presence snapshot to the new client
      server.send(JSON.stringify(this.presenceSnapshot()));

      // Broadcast updated presence to all others
      this.broadcast(this.presenceSnapshot());

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }
}
