import type { TextChunk, TextFileMetadata } from "./contracts";

export const TEXT_CHUNK_SIZE = 512 * 1024;

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
