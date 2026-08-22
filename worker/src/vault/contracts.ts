/**
 * Wire and storage contracts for SQLite-backed text and conflict resolution.
 * Conflict and acknowledgement behavior is implemented in later slices.
 */

export const R2_TEXT_STORAGE_VERSION = 1 as const;
export const SQLITE_TEXT_STORAGE_VERSION = 2 as const;
export const CURRENT_STORAGE_VERSION = SQLITE_TEXT_STORAGE_VERSION;
export const STORAGE_VERSION_STATE_KEY = "storage_version";

export type StorageVersion = number;

export interface TextFileMetadata {
  pathLower: string;
  path: string;
  revision: number;
  contentType: string;
  updatedAt: string;
  size: number;
  chunkCount: number;
}

export interface TextChunk {
  index: number;
  data: ArrayBuffer;
}

export interface FileAck {
  path: string;
  revision: number;
}

export interface AckRequest {
  acks: FileAck[];
}

export interface ConflictPayload {
  path: string;
  conflictNote: string;
  serverRevision: number;
  clientBaseRevision: number;
  serverContent?: string;
  clientContent?: string;
  baseContent?: string;
  isBinary?: boolean;
}

export type ConflictResolutionAction =
  | "keep-server"
  | "keep-client"
  | "use-merged";

export interface ResolveConflictRequest {
  path: string;
  conflictNote: string;
  action: ConflictResolutionAction;
  content?: string;
}

export function isTextContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("svg")
  );
}
