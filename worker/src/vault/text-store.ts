import type { TextChunk, TextFileMetadata } from "./contracts";
import { applyPatch } from "./patch";

export const TEXT_CHUNK_SIZE = 512 * 1024;
export const WEB_ACK_TTL_MS = 24 * 60 * 60 * 1000;

type TextFileRow = Record<string, SqlStorageValue> & {
  pathLower: SqlStorageValue;
  path: SqlStorageValue;
  revision: SqlStorageValue;
  contentType: SqlStorageValue;
  updatedAt: SqlStorageValue;
  size: SqlStorageValue;
  chunkCount: SqlStorageValue;
};

type TextChunkRow = Record<string, SqlStorageValue> & {
  chunkIndex: SqlStorageValue;
  data: SqlStorageValue;
};

type TextCheckpointRow = Record<string, SqlStorageValue> & {
  revision: SqlStorageValue;
  size: SqlStorageValue;
  chunkCount: SqlStorageValue;
};

type TextUpdateRow = Record<string, SqlStorageValue> & {
  fromRev: SqlStorageValue;
  toRev: SqlStorageValue;
  patch: SqlStorageValue;
};

type DeviceAckRow = Record<string, SqlStorageValue> & {
  deviceKey: SqlStorageValue;
  revision: SqlStorageValue;
  updatedAt: SqlStorageValue;
};

export function initializeTextStoreSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS text_files (
      path_lower   TEXT PRIMARY KEY,
      path         TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      size         INTEGER NOT NULL,
      chunk_count  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS text_chunks (
      path_lower TEXT NOT NULL,
      chunk_idx  INTEGER NOT NULL,
      data       BLOB NOT NULL,
      PRIMARY KEY (path_lower, chunk_idx)
    );

    CREATE TABLE IF NOT EXISTS text_checkpoints (
      path_lower  TEXT PRIMARY KEY,
      revision    INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS text_checkpoint_chunks (
      path_lower TEXT NOT NULL,
      chunk_idx  INTEGER NOT NULL,
      data       BLOB NOT NULL,
      PRIMARY KEY (path_lower, chunk_idx)
    );

    CREATE TABLE IF NOT EXISTS text_updates (
      path_lower TEXT NOT NULL,
      from_rev   INTEGER NOT NULL,
      to_rev     INTEGER NOT NULL,
      patch      TEXT NOT NULL,
      PRIMARY KEY (path_lower, to_rev)
    );

    CREATE TABLE IF NOT EXISTS text_update_chunks (
      path_lower TEXT NOT NULL,
      to_rev     INTEGER NOT NULL,
      chunk_idx  INTEGER NOT NULL,
      data       BLOB NOT NULL,
      PRIMARY KEY (path_lower, to_rev, chunk_idx)
    );

    CREATE TABLE IF NOT EXISTS device_acks (
      device_key TEXT NOT NULL,
      path_lower TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_key, path_lower)
    );
  `);
}

/**
 * Split encoded UTF-8 without ending a chunk in the middle of a code point.
 */
export function chunkUtf8(text: string, chunkSize = TEXT_CHUNK_SIZE): TextChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 4) {
    throw new Error("Text chunk size must be an integer of at least 4 bytes");
  }

  const bytes = new TextEncoder().encode(text);
  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < bytes.byteLength) {
    let end = Math.min(start + chunkSize, bytes.byteLength);
    if (end < bytes.byteLength) {
      while (end > start && isUtf8ContinuationByte(bytes[end])) end--;
      if (end === start) {
        throw new Error("Unable to find a valid UTF-8 chunk boundary");
      }
    }
    chunks.push({
      index: chunks.length,
      data: bytes.slice(start, end).buffer as ArrayBuffer,
    });
    start = end;
  }

  return chunks;
}

export class TextStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  hasHead(path: string): boolean {
    const row = this.storage.sql.exec(
      `SELECT path_lower FROM text_files WHERE path_lower = ?`,
      lowerPath(path)
    ).toArray()[0];
    return Boolean(row);
  }

  writeFile(input: {
    path: string;
    revision: number;
    contentType: string;
    updatedAt: string;
    text: string;
  }): TextFileMetadata {
    const pathLower = lowerPath(input.path);
    const chunks = chunkUtf8(input.text);
    const size = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);

    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec(`DELETE FROM text_chunks WHERE path_lower = ?`, pathLower);
      for (const chunk of chunks) {
        sql.exec(
          `INSERT INTO text_chunks (path_lower, chunk_idx, data) VALUES (?, ?, ?)`,
          pathLower,
          chunk.index,
          chunk.data
        );
      }
      sql.exec(
        `INSERT OR REPLACE INTO text_files
         (path_lower, path, revision, content_type, updated_at, size, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        pathLower,
        input.path,
        input.revision,
        input.contentType,
        input.updatedAt,
        size,
        chunks.length
      );
    });

    return {
      pathLower,
      path: input.path,
      revision: input.revision,
      contentType: input.contentType,
      updatedAt: input.updatedAt,
      size,
      chunkCount: chunks.length,
    };
  }

  writeCheckpoint(input: {
    path: string;
    revision: number;
    text: string;
    createdAt?: string;
  }): void {
    const pathLower = lowerPath(input.path);
    const chunks = chunkUtf8(input.text);
    const size = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);

    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec(`DELETE FROM text_checkpoint_chunks WHERE path_lower = ?`, pathLower);
      for (const chunk of chunks) {
        sql.exec(
          `INSERT INTO text_checkpoint_chunks (path_lower, chunk_idx, data) VALUES (?, ?, ?)`,
          pathLower,
          chunk.index,
          chunk.data
        );
      }
      sql.exec(
        `INSERT OR REPLACE INTO text_checkpoints
         (path_lower, revision, size, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        pathLower,
        input.revision,
        size,
        chunks.length,
        input.createdAt ?? new Date().toISOString()
      );
    });
  }

  readCheckpoint(path: string): { revision: number; text: string } | null {
    const pathLower = lowerPath(path);
    const row = this.storage.sql.exec<TextCheckpointRow>(
      `SELECT revision, size, chunk_count AS chunkCount
       FROM text_checkpoints WHERE path_lower = ?`,
      pathLower
    ).toArray()[0];
    if (!row) return null;

    return {
      revision: Number(row.revision),
      text: this.readChunkedText(
        "text_checkpoint_chunks",
        pathLower,
        Number(row.size),
        Number(row.chunkCount)
      ),
    };
  }

  appendUpdate(input: {
    path: string;
    fromRevision: number;
    toRevision: number;
    patch: string;
  }): void {
    const pathLower = lowerPath(input.path);
    const chunks = chunkUtf8(input.patch);
    const chunked =
      chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0) >
      TEXT_CHUNK_SIZE;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `DELETE FROM text_update_chunks WHERE path_lower = ? AND to_rev = ?`,
        pathLower,
        input.toRevision
      );
      if (chunked) {
        for (const chunk of chunks) {
          this.storage.sql.exec(
            `INSERT INTO text_update_chunks
             (path_lower, to_rev, chunk_idx, data) VALUES (?, ?, ?, ?)`,
            pathLower,
            input.toRevision,
            chunk.index,
            chunk.data
          );
        }
      }
      this.storage.sql.exec(
        `INSERT OR REPLACE INTO text_updates (path_lower, from_rev, to_rev, patch)
         VALUES (?, ?, ?, ?)`,
        pathLower,
        input.fromRevision,
        input.toRevision,
        chunked ? "" : input.patch
      );
    });
  }

  reconstruct(path: string, targetRevision: number): string | null {
    const head = this.readFile(path);
    if (!head || targetRevision > head.metadata.revision) return null;
    if (targetRevision === head.metadata.revision) return head.text;

    const checkpoint = this.readCheckpoint(path);
    if (!checkpoint || targetRevision < checkpoint.revision) return null;
    if (targetRevision === checkpoint.revision) return checkpoint.text;

    let text = checkpoint.text;
    let expectedFrom = checkpoint.revision;
    const updates = this.storage.sql.exec<TextUpdateRow>(
      `SELECT from_rev AS fromRev, to_rev AS toRev, patch
       FROM text_updates
       WHERE path_lower = ? AND to_rev > ? AND to_rev <= ?
       ORDER BY to_rev`,
      lowerPath(path),
      checkpoint.revision,
      targetRevision
    ).toArray();

    for (const update of updates) {
      const fromRev = Number(update.fromRev);
      const toRev = Number(update.toRev);
      if (fromRev !== expectedFrom || toRev !== expectedFrom + 1) return null;
      const patch = this.readUpdatePatch(
        lowerPath(path),
        toRev,
        String(update.patch)
      );
      const next = applyPatch(text, patch);
      if (next === null) return null;
      text = next;
      expectedFrom = toRev;
    }

    return expectedFrom === targetRevision ? text : null;
  }

  setAck(deviceKey: string, path: string, revision: number): boolean {
    const pathLower = lowerPath(path);
    const existing = this.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT revision FROM device_acks WHERE device_key = ? AND path_lower = ?`,
      deviceKey,
      pathLower
    ).toArray()[0];
    if (existing && Number(existing.revision) >= revision) return false;

    this.storage.sql.exec(
      `INSERT OR REPLACE INTO device_acks (device_key, path_lower, revision, updated_at)
       VALUES (?, ?, ?, ?)`,
      deviceKey,
      pathLower,
      revision,
      new Date().toISOString()
    );
    return true;
  }

  minAckRevision(
    path: string,
    retainedDeviceKeys: ReadonlySet<string>,
    now = Date.now()
  ): number | null {
    const rows = this.storage.sql.exec<DeviceAckRow>(
      `SELECT device_key AS deviceKey, revision, updated_at AS updatedAt
       FROM device_acks WHERE path_lower = ?`,
      lowerPath(path)
    ).toArray();
    let minimum: number | null = null;

    for (const row of rows) {
      const deviceKey = String(row.deviceKey);
      const retained = deviceKey.startsWith("web:")
        ? isRecentTimestamp(String(row.updatedAt), now - WEB_ACK_TTL_MS)
        : retainedDeviceKeys.has(deviceKey);
      if (!retained) continue;

      const revision = Number(row.revision);
      minimum = minimum === null ? revision : Math.min(minimum, revision);
    }
    return minimum;
  }

  advanceCheckpoint(path: string, revision: number): boolean {
    const current = this.readCheckpoint(path);
    if (current && current.revision >= revision) return false;
    const text = this.reconstruct(path, revision);
    if (text === null) return false;
    this.writeCheckpoint({ path, revision, text });
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `DELETE FROM text_update_chunks WHERE path_lower = ? AND to_rev <= ?`,
        lowerPath(path),
        revision
      );
      this.storage.sql.exec(
        `DELETE FROM text_updates WHERE path_lower = ? AND to_rev <= ?`,
        lowerPath(path),
        revision
      );
    });
    return true;
  }

  readFile(path: string): { metadata: TextFileMetadata; text: string } | null {
    const pathLower = lowerPath(path);
    const row = this.storage.sql.exec<TextFileRow>(
      `SELECT path_lower AS pathLower, path, revision, content_type AS contentType,
              updated_at AS updatedAt, size, chunk_count AS chunkCount
       FROM text_files WHERE path_lower = ?`,
      pathLower
    ).toArray()[0];
    if (!row) return null;

    const metadata = metadataFromRow(row);
    const rows = this.storage.sql.exec<TextChunkRow>(
      `SELECT chunk_idx AS chunkIndex, data
       FROM text_chunks WHERE path_lower = ? ORDER BY chunk_idx`,
      pathLower
    ).toArray();

    if (rows.length !== metadata.chunkCount) {
      throw new Error(`Text chunk count mismatch for ${metadata.path}`);
    }

    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    for (let index = 0; index < rows.length; index++) {
      const rowIndex = Number(rows[index].chunkIndex);
      const data = rows[index].data;
      if (rowIndex !== index || !(data instanceof ArrayBuffer)) {
        throw new Error(`Invalid text chunk ${index} for ${metadata.path}`);
      }
      const chunk = new Uint8Array(data);
      if (offset + chunk.byteLength > bytes.byteLength) {
        throw new Error(`Text chunks exceed declared size for ${metadata.path}`);
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== metadata.size) {
      throw new Error(`Text size mismatch for ${metadata.path}`);
    }

    return {
      metadata,
      text: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    };
  }

  deleteFile(path: string): void {
    const pathLower = lowerPath(path);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM text_chunks WHERE path_lower = ?`, pathLower);
      this.storage.sql.exec(`DELETE FROM text_files WHERE path_lower = ?`, pathLower);
      this.storage.sql.exec(
        `DELETE FROM text_checkpoint_chunks WHERE path_lower = ?`,
        pathLower
      );
      this.storage.sql.exec(
        `DELETE FROM text_checkpoints WHERE path_lower = ?`,
        pathLower
      );
      this.storage.sql.exec(
        `DELETE FROM text_update_chunks WHERE path_lower = ?`,
        pathLower
      );
      this.storage.sql.exec(`DELETE FROM text_updates WHERE path_lower = ?`, pathLower);
      this.storage.sql.exec(`DELETE FROM device_acks WHERE path_lower = ?`, pathLower);
    });
  }

  renameFile(oldPath: string, newPath: string): void {
    const oldPathLower = lowerPath(oldPath);
    const newPathLower = lowerPath(newPath);
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      if (oldPathLower !== newPathLower) {
        sql.exec(
          `UPDATE text_chunks SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
        sql.exec(
          `UPDATE text_files SET path_lower = ?, path = ? WHERE path_lower = ?`,
          newPathLower,
          newPath,
          oldPathLower
        );
        sql.exec(
          `UPDATE text_checkpoint_chunks SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
        sql.exec(
          `UPDATE text_checkpoints SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
        sql.exec(
          `UPDATE text_update_chunks SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
        sql.exec(
          `UPDATE text_updates SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
        sql.exec(
          `UPDATE device_acks SET path_lower = ? WHERE path_lower = ?`,
          newPathLower,
          oldPathLower
        );
      } else {
        sql.exec(`UPDATE text_files SET path = ? WHERE path_lower = ?`, newPath, oldPathLower);
      }
    });
  }

  private readChunkedText(
    table: "text_chunks" | "text_checkpoint_chunks",
    pathLower: string,
    size: number,
    chunkCount: number
  ): string {
    const rows = this.storage.sql.exec<TextChunkRow>(
      `SELECT chunk_idx AS chunkIndex, data
       FROM ${table} WHERE path_lower = ? ORDER BY chunk_idx`,
      pathLower
    ).toArray();

    if (rows.length !== chunkCount) {
      throw new Error(`Text chunk count mismatch for ${pathLower}`);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; index < rows.length; index++) {
      const rowIndex = Number(rows[index].chunkIndex);
      const data = rows[index].data;
      if (rowIndex !== index || !(data instanceof ArrayBuffer)) {
        throw new Error(`Invalid text chunk ${index} for ${pathLower}`);
      }
      const chunk = new Uint8Array(data);
      if (offset + chunk.byteLength > bytes.byteLength) {
        throw new Error(`Text chunks exceed declared size for ${pathLower}`);
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== size) {
      throw new Error(`Text size mismatch for ${pathLower}`);
    }

    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  }

  private readUpdatePatch(
    pathLower: string,
    toRevision: number,
    inlinePatch: string
  ): string {
    if (inlinePatch !== "") return inlinePatch;
    const rows = this.storage.sql.exec<TextChunkRow>(
      `SELECT chunk_idx AS chunkIndex, data
       FROM text_update_chunks
       WHERE path_lower = ? AND to_rev = ?
       ORDER BY chunk_idx`,
      pathLower,
      toRevision
    ).toArray();
    if (rows.length === 0) return "";

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let index = 0; index < rows.length; index++) {
      const data = rows[index].data;
      if (Number(rows[index].chunkIndex) !== index || !(data instanceof ArrayBuffer)) {
        throw new Error(`Invalid update chunk ${index} for ${pathLower}`);
      }
      const chunk = new Uint8Array(data);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  }
}

function metadataFromRow(row: TextFileRow): TextFileMetadata {
  return {
    pathLower: String(row.pathLower),
    path: String(row.path),
    revision: Number(row.revision),
    contentType: String(row.contentType),
    updatedAt: String(row.updatedAt),
    size: Number(row.size),
    chunkCount: Number(row.chunkCount),
  };
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function lowerPath(path: string): string {
  return path.toLowerCase();
}

function isRecentTimestamp(value: string, cutoff: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}
