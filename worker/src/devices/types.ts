/**
 * Unified Device model types — Slice 23.
 */

import type { DeviceKind } from "../vault/identity";
import { deviceAuthor } from "../vault/identity";

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
  serverContent?: string;
  clientContent?: string;
  baseContent?: string;
  serverRevision: number;
  clientBaseRevision: number;
  deviceName: string;
  timestamp: string;
  isBinary?: boolean;
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

export interface DeviceRecord {
  id: string;
  vaultId: string;
  ownerId: string;
  deviceName: string;
  kind: DeviceKind;
  capabilities: DeviceCapabilities;
  conflictPolicy: ConflictPolicy;
  syncCursor: string | null;
  receiveInternals: boolean;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export const DEFAULT_PLUGIN_CAPABILITIES: DeviceCapabilities = {
  bidirectional: true,
  realtime: true,
  offlineQueue: true,
  receiveInternals: false,
  transport: "rest",
};

export const DEFAULT_AGENT_CAPABILITIES: DeviceCapabilities = {
  bidirectional: true,
  realtime: false,
  offlineQueue: false,
  receiveInternals: false,
  transport: "rest",
};

export function identityFromRecord(record: Pick<DeviceRecord, "id" | "kind" | "deviceName">): DeviceIdentity {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.deviceName,
    author: deviceAuthor(record.kind, record.id),
  };
}

export function parseCapabilitiesJson(raw: string | null): DeviceCapabilities {
  if (!raw) return DEFAULT_PLUGIN_CAPABILITIES;
  try {
    return { ...DEFAULT_PLUGIN_CAPABILITIES, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PLUGIN_CAPABILITIES;
  }
}

export function capabilitiesToJson(capabilities: DeviceCapabilities): string {
  return JSON.stringify(capabilities);
}
