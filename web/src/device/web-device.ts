/**
 * WebDevice — Slice 23 Device interface implementation.
 */

import * as api from "../api";
import { deviceAuthor } from "../identity";
import type {
  ChangeNotification,
  ConflictResolutionRequest,
  Device,
  DeviceCapabilities,
  DeviceIdentity,
  EditOp,
  Resolution,
  SendResult,
} from "./types";
import { assertDeviceWritable, DEFAULT_WEB_CAPABILITIES } from "./types";

export interface WebDeviceOptions {
  vaultId: string;
  sessionId: string;
  writable?: boolean;
  getTabRevision: (path: string) => number | undefined;
  setTabContent: (path: string, content: string, revision: number) => void;
  onRemoteChange: (change: ChangeNotification) => Promise<void>;
}

export class WebDevice implements Device {
  readonly conflictPolicy = "rebase" as const;
  readonly identity: DeviceIdentity;

  constructor(private readonly options: WebDeviceOptions) {
    this.identity = {
      id: options.sessionId,
      kind: "web",
      displayName: "Web session",
      author: deviceAuthor("web", options.sessionId),
    };
  }

  get writable(): boolean {
    return this.options.writable !== false;
  }

  get capabilities(): DeviceCapabilities {
    return {
      ...DEFAULT_WEB_CAPABILITIES,
      writable: this.writable,
      bidirectional: this.writable,
    };
  }

  async sendEdit(op: EditOp): Promise<SendResult> {
    assertDeviceWritable(this);
    if (op.kind !== "put" || op.content === undefined) {
      throw new Error("Web device only supports put edits");
    }
    const text = new TextDecoder().decode(op.content);
    const entry = await api.putTextFile(this.options.vaultId, op.path, text, {
      baseRevision: op.baseRevision,
    });
    return { revision: entry.revision, conflictNote: (entry as { conflictNote?: string }).conflictNote };
  }

  async receiveEdit(change: ChangeNotification): Promise<void> {
    if (change.author === this.identity.author) return;
    await this.options.onRemoteChange(change);
  }

  async resolveConflict(
    request: ConflictResolutionRequest
  ): Promise<Resolution> {
    assertDeviceWritable(this);
    const result = await api.resolveConflict(this.options.vaultId, request);
    const content =
      request.action === "keep-server"
        ? await api.getFileText(this.options.vaultId, result.entry.path)
        : request.content;
    if (content !== undefined) {
      this.options.setTabContent(
        result.entry.path,
        content,
        result.entry.revision
      );
    }
    return { kind: "merged", revision: result.entry.revision };
  }

  getCursor(path: string): number | string | null {
    return this.options.getTabRevision(path) ?? null;
  }

  async setCursor(path: string, cursor: number | string): Promise<void> {
    if (typeof cursor !== "number") return;
    // Tab state is managed by VaultWorkspace; cursor updates flow through dispatch.
    void path;
    void cursor;
  }

  reportPresence(_openPath: string | null): void {
    // Web presence is handled by useVaultNotify hook.
  }
}
