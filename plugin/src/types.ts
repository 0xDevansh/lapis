export interface LapisSettings {
  serverUrl: string;
  vaultId: string;
  syncToken: string;
  deviceName: string;
  receiveInternals: boolean;
  lastConnectedAt: string | null;
}

export interface ManifestEntry {
  path: string;
  size: number;
  contentType: string;
  updatedAt: string;
  revision: number;
}

export interface VaultManifest {
  version: 1;
  vaultId: string;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

export interface SyncJournal {
  version: 1;
  vaultId: string;
  lastSyncAt: string;
  fileRevisions: Record<string, number>;
  fileHashes: Record<string, string>;
  pendingOps: PendingOp[];
}

export type PendingOp = PendingPutOp | PendingPatchOp | PendingRenameOp | PendingDeleteOp;

export interface PendingPutOp {
  op: "put";
  path: string;
  contentBase64: string;
  contentType: string;
  baseRevision?: number;
}

export interface PendingPatchOp {
  op: "patch";
  path: string;
  patch: string;
  baseRevision: number;
  clientContent: string;
  baseContent?: string;
}

export interface PendingRenameOp {
  op: "rename";
  oldPath: string;
  newPath: string;
}

export interface PendingDeleteOp {
  op: "delete";
  path: string;
}

export interface BatchOpResult {
  op: PendingOp;
  path: string;
  status: "accepted" | "merged" | "conflict" | "error";
  conflictPath?: string;
  error?: string;
  entry?: ManifestEntry;
}

export interface BatchSyncResponse {
  results: BatchOpResult[];
}

export interface PluginData {
  settings?: Partial<LapisSettings>;
  journal?: SyncJournal | null;
}

export interface SeedCompleteResult {
  ok: boolean;
  commitHash?: string;
  fileCount: number;
  remote?: string;
}

export const DEFAULT_SETTINGS: LapisSettings = {
  serverUrl: "http://localhost:8787",
  vaultId: "",
  syncToken: "",
  deviceName: "",
  receiveInternals: false,
  lastConnectedAt: null,
};

export interface DeviceAuthRequest {
  vaultId: string;
  deviceName: string;
}

export interface DeviceAuthChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "approved"; token: string }
  | { status: "denied" | "expired" | "not_found" };

export interface LapisRequestOptions {
  method?: string;
  path: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  token?: string;
  headers?: Record<string, string>;
}

export interface ConflictResponse {
  conflict: true;
  conflictPath: string;
  entry: ManifestEntry;
}

export interface PatchResponse {
  merged?: boolean;
  entry: ManifestEntry;
}

export interface LapisResponse<T> {
  status: number;
  data: T | null;
  text: string;
}
