export interface LapisSettings {
  serverUrl: string;
  vaultId: string;
  syncToken: string;
  deviceId: string;
  deviceName: string;
  receiveInternals: boolean;
  debugLogging: boolean;
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
  op: PendingOp["op"];
  path: string;
  status: "accepted" | "stale" | "error";
  error?: string;
  headRevision?: number;
  entry?: ManifestEntry;
}

export interface BatchSyncResponse {
  results: BatchOpResult[];
}

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

export interface PresenceSession {
  identity: string;
  openPath: string | null;
}

export interface PresenceNotification {
  type: "presence";
  sessions: PresenceSession[];
}

export interface SameFileWarning {
  type: "same_file_warning";
  path: string;
  others: string[];
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
  deviceId: "",
  deviceName: "",
  receiveInternals: false,
  debugLogging: false,
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
  | { status: "approved"; token: string; deviceId: string }
  | { status: "denied" | "expired" | "not_found" };

export interface LapisRequestOptions {
  method?: string;
  path: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  token?: string;
  headers?: Record<string, string>;
}

export interface StaleWriteResponse {
  error?: string;
  headRevision?: number;
  serverRevision?: number;
}

export interface PatchResponse {
  entry: ManifestEntry;
}

export interface LapisResponse<T> {
  status: number;
  data: T | null;
  text: string;
}
