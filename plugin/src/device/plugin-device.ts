/**
 * PluginDevice — Slice 23 Device interface implementation.
 */

import type { App } from "obsidian";
import type { LapisSettings, SyncJournal } from "../types";
import { deviceAuthor } from "../identity";
import { LapisClient } from "../net/client";
import { NotifyClient } from "../net/notify";
import { SyncEngine } from "../sync/engine";
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
import { DEFAULT_PLUGIN_CAPABILITIES } from "./types";

export interface PluginDeviceOptions {
  app: App;
  settings: LapisSettings;
  getJournal: () => SyncJournal | null;
  setJournal: (journal: SyncJournal) => Promise<void>;
  notifyClient?: NotifyClient | null;
}

export class PluginDevice implements Device {
  readonly capabilities: DeviceCapabilities = DEFAULT_PLUGIN_CAPABILITIES;
  readonly conflictPolicy = "rebase" as const;
  readonly identity: DeviceIdentity;
  private readonly client: LapisClient;
  private readonly engine: SyncEngine;

  constructor(private readonly options: PluginDeviceOptions) {
    this.identity = {
      id: options.settings.deviceId,
      kind: "plugin",
      displayName: options.settings.deviceName,
      author: deviceAuthor("plugin", options.settings.deviceId),
    };
    this.client = new LapisClient(options.settings.serverUrl);
    this.engine = new SyncEngine({
      app: options.app,
      settings: options.settings,
      client: this.client,
      getJournal: options.getJournal,
      setJournal: options.setJournal,
    });
  }

  async sendEdit(op: EditOp): Promise<SendResult> {
    if (op.kind === "put") {
      await this.engine.pushPut(op.path);
      const journal = this.options.getJournal();
      const rev = journal?.fileRevisions[op.path.toLowerCase()] ?? 0;
      return { revision: rev };
    }
    if (op.kind === "rename" && op.newPath) {
      await this.engine.pushRename(op.path, op.newPath);
      return { revision: 0 };
    }
    if (op.kind === "delete") {
      await this.engine.pushDelete(op.path);
      return { revision: 0 };
    }
    throw new Error(`Unsupported edit op: ${op.kind}`);
  }

  async receiveEdit(change: ChangeNotification): Promise<void> {
    if (change.author === this.identity.author) return;
    if (change.kind === "put") {
      await this.engine.applyRemotePut(change.path, change.revision ?? 0, change.patch, change.baseRevision);
    } else if (change.kind === "rename" && change.newPath) {
      await this.engine.applyRemoteRename(change.path, change.newPath);
    } else if (change.kind === "delete") {
      await this.engine.applyRemoteDelete(change.path);
    }
  }

  async resolveConflict(
    request: ConflictResolutionRequest
  ): Promise<Resolution> {
    const result = await this.client.resolveConflict(
      this.options.settings.vaultId,
      request,
      this.options.settings.syncToken
    );
    await this.engine.applyRemotePut(result.entry.path);
    await this.engine.applyRemoteDelete(result.conflictNote);
    return { kind: "merged", revision: result.entry.revision };
  }

  getCursor(path: string): number | string | null {
    const journal = this.options.getJournal();
    return journal?.fileRevisions[path.toLowerCase()] ?? null;
  }

  async setCursor(path: string, cursor: number | string): Promise<void> {
    const journal = this.options.getJournal();
    if (!journal || typeof cursor !== "number") return;
    journal.fileRevisions[path.toLowerCase()] = cursor;
    await this.options.setJournal(journal);
  }

  reportPresence(openPath: string | null): void {
    if (openPath) {
      this.options.notifyClient?.sendOpen(openPath);
    } else {
      this.options.notifyClient?.sendCloseFile();
    }
  }
}
