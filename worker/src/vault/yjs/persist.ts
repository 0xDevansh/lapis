import * as Y from "yjs";

const SNAPSHOT_KEY = "snapshot";

function ensureTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS yjs_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS yjs_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/** Copy into a standalone ArrayBuffer so SQLite bindings never see a SharedArrayBuffer view. */
function asBlob(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function asUint8(value: SqlStorageValue): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string" && value.length > 0) {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function loadYDoc(sql: SqlStorage): Y.Doc {
  ensureTables(sql);
  const doc = new Y.Doc();

  const snapRow = sql
    .exec<{ value: SqlStorageValue }>(`SELECT value FROM yjs_meta WHERE key = ?`, SNAPSHOT_KEY)
    .toArray()[0];
  if (snapRow) {
    const snap = asUint8(snapRow.value);
    if (snap && snap.byteLength > 0) Y.applyUpdate(doc, snap);
  }

  for (const row of sql.exec<{ data: SqlStorageValue }>(`SELECT data FROM yjs_updates ORDER BY id`).toArray()) {
    const update = asUint8(row.data);
    if (update && update.byteLength > 0) Y.applyUpdate(doc, update);
  }

  return doc;
}

export function appendUpdate(sql: SqlStorage, update: Uint8Array): void {
  ensureTables(sql);
  sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, asBlob(update));
}

export function compactYDoc(sql: SqlStorage, doc: Y.Doc): void {
  ensureTables(sql);
  const snapshot = Y.encodeStateAsUpdate(doc);
  sql.exec(
    `INSERT OR REPLACE INTO yjs_meta (key, value) VALUES (?, ?)`,
    SNAPSHOT_KEY,
    bytesToBase64(snapshot)
  );
  sql.exec(`DELETE FROM yjs_updates`);
}
