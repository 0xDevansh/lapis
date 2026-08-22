/**
 * GitHubDevice — Slice 26 Device interface for git transport peers.
 *
 * Inbound/outbound sync is driven by the VaultCoordinator seal loop;
 * this class documents the contract and cursor semantics.
 */

import type { ConflictPolicy, Device, DeviceCapabilities, DeviceIdentity, EditOp, SendResult, ChangeNotification, ConflictResolutionRequest, Resolution } from "../devices/types";
import { deviceAuthor } from "../vault/identity";

export const DEFAULT_GITHUB_CAPABILITIES: DeviceCapabilities = {
  bidirectional: true,
  realtime: false,
  offlineQueue: false,
  receiveInternals: false,
  transport: "git",
};

export class GitHubDevice implements Device {
  readonly capabilities = DEFAULT_GITHUB_CAPABILITIES;
  readonly conflictPolicy: ConflictPolicy;
  readonly identity: DeviceIdentity;

  constructor(
    private readonly remoteId: string,
    private readonly displayName: string,
    conflictPolicy: ConflictPolicy = "merge3",
    private lastSyncedCommit: string | null = null
  ) {
    this.conflictPolicy = conflictPolicy;
    this.identity = {
      id: remoteId,
      kind: "github",
      displayName,
      author: deviceAuthor("github", remoteId),
    };
  }

  async sendEdit(_op: EditOp): Promise<SendResult> {
    // Outbound batching is handled by sealToRemote in the coordinator alarm.
    return { revision: 0 };
  }

  async receiveEdit(_change: ChangeNotification): Promise<void> {
    // Inbound sync runs via reconcileInbound on seal / webhook.
  }

  async resolveConflict(_request: ConflictResolutionRequest): Promise<Resolution> {
    return { kind: "conflict-note", notePath: "" };
  }

  getCursor(_path: string): string | null {
    return this.lastSyncedCommit;
  }

  async setCursor(_path: string, cursor: number | string): Promise<void> {
    if (typeof cursor === "string") this.lastSyncedCommit = cursor;
  }

  reportPresence(_openPath: string | null): void {
    // Git peers do not participate in WebSocket presence.
  }
}
