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
import { applyPatch } from "./patch";

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
 */
export class VaultCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;

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

    return new Response("Not found", { status: 404 });
  }
}
