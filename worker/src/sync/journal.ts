/**
 * Sync Journal types — Slice 12.
 *
 * These types define the shape of the local journal that an Obsidian plugin
 * (or any Lapis Local Vault client) maintains on-device for offline operation
 * and reconnect recovery.
 *
 * The journal is stored entirely on the client (e.g. as a JSON file in the
 * plugin's data directory). The server does not store it. These types are
 * published here as the canonical contract between the plugin and the sync API.
 *
 * Journal lifecycle:
 *   1. On first sync: populate from the server manifest.
 *   2. On each accepted sync: update lastRevision and fileRevisions.
 *   3. While offline: append pending ops to pendingOps in order.
 *   4. On reconnect: replay pendingOps via POST /api/sync/:vaultId/batch,
 *      then refresh fileRevisions from the server manifest.
 *   5. If journal is corrupt / invalid: drop it and perform a full scan
 *      against GET /api/sync/:vaultId/manifest.
 */

/** A pending operation recorded while offline. */
export type PendingOp =
  | PendingPutOp
  | PendingPatchOp
  | PendingRenameOp
  | PendingDeleteOp;

/** Upload the full content of a file (new file or binary update). */
export interface PendingPutOp {
  op: "put";
  path: string;
  /** Base64-encoded file content. */
  contentBase64: string;
  contentType: string;
  /** Local revision at the time the change was recorded. */
  baseRevision: number;
}

/**
 * Apply a unified diff to a text file.
 * The server rejects stale patches with a `stale` batch result; clients rebase
 * locally and retry.
 */
export interface PendingPatchOp {
  op: "patch";
  path: string;
  patch: string;
  baseRevision: number;
}

/** Rename or move a file. */
export interface PendingRenameOp {
  op: "rename";
  oldPath: string;
  newPath: string;
}

/** Delete a file. */
export interface PendingDeleteOp {
  op: "delete";
  path: string;
}

/** The result of replaying a single pending op. */
export interface BatchOpResult {
  op: PendingOp["op"];
  path: string;
  status: "accepted" | "stale" | "error";
  /** On error: human-readable message. */
  error?: string;
  /** On stale: latest server revision to rebase against. */
  headRevision?: number;
  /** Updated manifest entry (present on accepted/merged). */
  entry?: Record<string, unknown>;
}

/** Request body for POST /api/sync/:vaultId/batch. */
export interface BatchSyncRequest {
  ops: PendingOp[];
}

/** Response body for POST /api/sync/:vaultId/batch. */
export interface BatchSyncResponse {
  results: BatchOpResult[];
}

/**
 * The on-device journal state (stored by the plugin, not the server).
 * Exposed here as the canonical type for plugin authors.
 */
export interface SyncJournal {
  /** Journal format version. Increment when the schema changes incompatibly. */
  version: 1;
  vaultId: string;
  /** ISO 8601 timestamp of the last successful sync. */
  lastSyncAt: string;
  /** Per-file: last accepted server revision. */
  fileRevisions: Record<string, number>; // path.toLowerCase() → revision
  /** Per-file: SHA-256 hash of local content (hex). For full-scan dedup. */
  fileHashes: Record<string, string>; // path.toLowerCase() → hash
  /** Ordered list of operations recorded while offline. */
  pendingOps: PendingOp[];
}
