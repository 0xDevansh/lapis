/**
 * Web Device types — mirrors worker/src/devices/types.ts (Slice 23).
 */

export type DeviceKind = "plugin" | "web" | "agent" | "github";
export type ConflictPolicy = "rebase" | "merge3" | "conflict-note" | "pr";

export interface DeviceCapabilities {
  bidirectional: boolean;
  realtime: boolean;
  offlineQueue: boolean;
  receiveInternals: boolean;
  transport: "rest" | "git";
}

export interface DeviceIdentity {
  id: string;
  kind: DeviceKind;
  displayName: string;
  author: string;
}

export interface EditOp {
  kind: "put" | "patch" | "rename" | "delete";
  path: string;
  baseRevision?: number;
  patch?: string;
  content?: Uint8Array;
  newPath?: string;
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

export interface ConflictContext {
  path: string;
  serverRevision: number;
  clientBaseRevision: number;
  deviceName: string;
  timestamp: string;
}

export type ConflictResolutionAction =
  | "keep-server"
  | "keep-client"
  | "use-merged";

export interface ConflictResolutionRequest {
  path: string;
  conflictNote: string;
  action: ConflictResolutionAction;
  content?: string;
}

export type Resolution = { kind: "merged"; revision: number } | { kind: "conflict-note"; notePath: string };

export interface SendResult {
  revision: number;
  conflictNote?: string;
}

export interface Device {
  readonly identity: DeviceIdentity;
  readonly capabilities: DeviceCapabilities;
  readonly conflictPolicy: ConflictPolicy;
  sendEdit(op: EditOp): Promise<SendResult>;
  receiveEdit(change: ChangeNotification): Promise<void>;
  resolveConflict(request: ConflictResolutionRequest): Promise<Resolution>;
  getCursor(path: string): number | string | null;
  setCursor(path: string, cursor: number | string): Promise<void>;
  reportPresence(openPath: string | null): void;
}

export const DEFAULT_WEB_CAPABILITIES: DeviceCapabilities = {
  bidirectional: true,
  realtime: true,
  offlineQueue: false,
  receiveInternals: false,
  transport: "rest",
};
