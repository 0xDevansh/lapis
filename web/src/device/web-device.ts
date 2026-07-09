/**
 * WebDevice — Slice 23 Device interface implementation.
 */

import * as api from "../api";
import { deviceAuthor } from "../identity";
import type {
  ChangeNotification,
  ConflictContext,
  Device,
  DeviceCapabilities,
  DeviceIdentity,
  EditOp,
  Resolution,
  SendResult,
} from "./types";
import { DEFAULT_WEB_CAPABILITIES } from "./types";

export interface WebDeviceOptions {
  vaultId: string;
  sessionId: string;
  getTabRevision: (path: string) => number | undefined;
  setTabContent: (path: string, content: string, revision: number) => void;
  onRemoteChange: (change: ChangeNotification) => Promise<void>;
}

export class WebDevice implements Device {
  readonly capabilities: DeviceCapabilities = DEFAULT_WEB_CAPABILITIES;
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

  async sendEdit(op: EditOp): Promise<SendResult> {
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

  async resolveConflict(_ctx: ConflictContext): Promise<Resolution> {
    return { kind: "merged", revision: 0 };
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
