import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

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
 * Future slices add:
 *   - R2 manifest management (Slice 02)
 *   - File operation handlers (Slice 03)
 *   - WebSocket connections for live notifications (Slice 10)
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
