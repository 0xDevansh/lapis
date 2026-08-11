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

export interface ChangeNotification {
  type: "change";
  path: string;
  kind: "put" | "rename" | "delete";
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
  /** Yjs FS bridge index (path ↔ fileId + hashes) */
  fsIndex?: import("./sync/reconcile").FsIndexState | null;
  /** Base64-encoded Yjs document state for offline */
  yjsStateBase64?: string | null;
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

export interface LapisResponse<T> {
  status: number;
  data: T | null;
  text: string;
}
