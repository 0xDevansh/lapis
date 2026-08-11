import { Notice, Plugin, TFile } from "obsidian";
import { LapisClient } from "./net/client";
import { NotifyClient, type NotifyMessage } from "./net/notify";
import { LapisSettingTab, normalizeSettings } from "./settings";
import type { LapisSettings, PluginData } from "./types";
import { bytesToBase64, base64ToBytes } from "./sync/hash";
import { isValidFsIndex, type FsIndexState } from "./sync/reconcile";
import { YjsFsBridge } from "./sync/yjs-fs-bridge";
import { ConnectModal } from "./ui/connect-modal";
import { LapisStatusBar } from "./ui/status";

const LOCAL_CHANGE_DEBOUNCE_MS = 5_000;

export default class LapisPlugin extends Plugin {
  settings!: LapisSettings;
  fsIndex: FsIndexState | null = null;
  yjsState: Uint8Array | null = null;
  settingTab!: LapisSettingTab;
  private statusBar!: LapisStatusBar;
  private modifyTimers = new Map<string, number>();
  private suppressWatcher = false;
  private notifyClient: NotifyClient | null = null;
  private bridge: YjsFsBridge | null = null;
  private lastPresenceCount = 0;
  private currentOpenPath: string | null = null;
  private syncChain: Promise<void> = Promise.resolve();

  async onload() {
    await this.loadSettings();

    this.statusBar = new LapisStatusBar(this.addStatusBarItem());
    this.updateStatus();

    this.addCommand({
      id: "connect",
      name: "Connect",
      callback: () => void this.connect(),
    });

    this.addCommand({
      id: "disconnect",
      name: "Disconnect",
      callback: () => void this.disconnect(),
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });

    this.addCommand({
      id: "show-sync-diagnostics",
      name: "Show sync diagnostics",
      callback: () => void this.showSyncDiagnostics(),
    });

    this.settingTab = new LapisSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerWatcher();
    this.registerEditorChangeFallback();

    if (this.settings.syncToken) {
      this.startNotify();
      void this.startBridge();
    }

    this.registerInterval(
      window.setInterval(() => {
        if (this.bridge) void this.enqueueSync(() => this.bridge!.reconcileFromDisk().then(() => undefined));
      }, 5 * 60 * 1000)
    );
    this.registerInterval(window.setInterval(() => this.reportOpenFile(), 2000));
  }

  onunload() {
    this.bridge?.stop();
    this.bridge = null;
    this.notifyClient?.close();
  }

  async loadSettings() {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = normalizeSettings(data?.settings ?? data);
    this.fsIndex =
      data?.fsIndex && isValidFsIndex(data.fsIndex, this.settings.vaultId) ? data.fsIndex : null;
    if (data?.yjsStateBase64) {
      try {
        this.yjsState = new Uint8Array(base64ToBytes(data.yjsStateBase64));
      } catch {
        this.yjsState = null;
      }
    }
  }

  async saveSettings() {
    await this.savePluginData();
    this.updateStatus();
  }

  refreshSettingsTab() {
    this.settingTab?.display();
  }

  async connect() {
    if (!this.settings.serverUrl.trim() || !this.settings.vaultId.trim()) {
      new Notice("Lapis: open Settings → Lapis sync and paste your vault link");
      this.openSettingsTab();
      return;
    }

    this.updateStatus("connecting");
    const client = new LapisClient(this.settings.serverUrl);

    try {
      const challenge = await client.requestDeviceCode({
        vaultId: this.settings.vaultId,
        deviceName: this.settings.deviceName,
      });

      new ConnectModal(this.app, {
        serverUrl: this.settings.serverUrl,
        vaultId: this.settings.vaultId,
        challenge,
        fetchToken: (deviceCode) => client.pollDeviceToken(deviceCode),
        onConnected: async ({ token, deviceId }) => {
          this.settings.syncToken = token;
          this.settings.deviceId = deviceId;
          this.settings.lastConnectedAt = new Date().toISOString();
          await this.saveSettings();
          this.refreshSettingsTab();
          this.startNotify();
          await this.startBridge();
          await this.syncNow();
        },
        onDone: () => this.updateStatus(),
      }).open();
    } catch (error) {
      this.updateStatus();
      const message = error instanceof Error ? error.message : "Connection failed";
      new Notice(`Lapis: ${message}`);
    }
  }

  async disconnect() {
    this.bridge?.stop();
    this.bridge = null;
    this.settings.syncToken = "";
    this.settings.deviceId = "";
    this.settings.lastConnectedAt = null;
    this.fsIndex = null;
    this.yjsState = null;
    this.notifyClient?.close();
    this.notifyClient = null;
    await this.saveSettings();
    this.refreshSettingsTab();
    new Notice("Lapis: disconnected");
  }

  async setReceiveInternals(receiveInternals: boolean) {
    const previous = this.settings.receiveInternals;
    this.settings.receiveInternals = receiveInternals;
    try {
      if (this.settings.syncToken) {
        await new LapisClient(this.settings.serverUrl).updateDevice(
          this.settings.vaultId,
          this.settings.syncToken,
          receiveInternals
        );
      }
      await this.saveSettings();
      new Notice(`Lapis: Vault Internals ${receiveInternals ? "enabled" : "disabled"}`);
    } catch (error) {
      this.settings.receiveInternals = previous;
      await this.saveSettings();
      const message = error instanceof Error ? error.message : "Could not update device";
      new Notice(`Lapis: ${message}`);
    }
  }

  async syncNow() {
    if (!this.settings.syncToken) {
      new Notice("Lapis: connect before syncing");
      return;
    }

    await this.enqueueSync(async () => {
      this.updateStatus("syncing");
      try {
        if (!this.bridge) await this.startBridge();
        const result = await this.bridge!.reconcileFromDisk();
        new Notice(
          result.ops > 0
            ? `Lapis: reconciled ${result.ops} change${result.ops === 1 ? "" : "s"}`
            : "Lapis: sync complete"
        );
        this.updateStatus();
      } catch (error) {
        this.updateStatus("error");
        const message = error instanceof Error ? error.message : "Sync failed";
        new Notice(`Lapis: ${message}`);
      }
    });
  }

  private async startBridge(): Promise<void> {
    if (this.bridge || !this.settings.syncToken) return;
    this.bridge = new YjsFsBridge({
      app: this.app,
      settings: this.settings,
      getIndex: () => this.fsIndex,
      setIndex: async (index) => {
        this.fsIndex = index;
        await this.savePluginData();
      },
      getYjsState: () => this.yjsState,
      setYjsState: async (state) => {
        this.yjsState = state;
        await this.savePluginData();
      },
      onStatus: (s) => {
        if (s === "connected") this.updateStatus("idle");
        else if (s === "syncing") this.updateStatus("syncing");
        else if (s === "error") this.updateStatus("error");
        else this.updateStatus("idle");
      },
    });
    await this.bridge.start();
  }

  private async showSyncDiagnostics() {
    const localCount = this.app.vault.getFiles().length;
    const indexCount = this.fsIndex ? Object.keys(this.fsIndex.pathToId).length : 0;
    const msg = `Lapis: local files ${localCount}, indexed ${indexCount}, yjs ${this.bridge ? "on" : "off"}`;
    console.info("[lapis] diagnostics", { localCount, indexCount, hasState: Boolean(this.yjsState) });
    new Notice(msg);
  }

  private updateStatus(state: "idle" | "connecting" | "syncing" | "error" = "idle") {
    this.statusBar?.update(this.settings, state, 0);
  }

  private startNotify() {
    if (!this.settings.syncToken || !this.settings.vaultId || this.notifyClient) {
      return;
    }
    this.notifyClient = new NotifyClient({
      serverUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      token: this.settings.syncToken,
      onOpen: (reconnected) => {
        this.updateStatus();
        if (reconnected) {
          this.debug("notify reconnected");
          void this.bridge?.reconcileFromDisk();
        }
        this.reportOpenFile(true);
      },
      onClose: () => this.statusBar.offline(0, 0),
      onMessage: (message) => this.handleNotifyMessage(message),
    });
    this.notifyClient.connect();
  }

  private handleNotifyMessage(message: NotifyMessage) {
    // File content sync is Yjs; notify channel is presence-only now.
    if (message.type === "presence") {
      const others = message.sessions.filter((s) => !s.identity.startsWith("plugin:"));
      if (others.length !== this.lastPresenceCount && others.length > 0) {
        new Notice(`Lapis: ${others.length} other session${others.length === 1 ? "" : "s"} connected`);
      }
      this.lastPresenceCount = others.length;
      return;
    }
    if (message.type === "same_file_warning") {
      new Notice(`Lapis: another session is editing ${message.path}`);
    }
  }

  private reportOpenFile(force = false) {
    const activeFile = this.app.workspace.getActiveFile();
    const nextPath = activeFile?.path ?? null;
    if (!force && nextPath === this.currentOpenPath) return;
    this.currentOpenPath = nextPath;
    if (nextPath) this.notifyClient?.sendOpen(nextPath);
    else this.notifyClient?.sendCloseFile();
  }

  private registerWatcher() {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.suppressWatcher || !this.bridge) return;
        if (file instanceof TFile) this.scheduleLocalFlush(file.path, "create");
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.suppressWatcher || !this.bridge) return;
        if (file instanceof TFile) this.scheduleLocalFlush(file.path, "modify");
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.suppressWatcher || !this.bridge) return;
        if (file instanceof TFile) {
          this.debug("watcher rename", oldPath, "->", file.path);
          void this.enqueueSync(() => this.bridge!.onLocalRename(oldPath, file.path));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.suppressWatcher || !this.bridge) return;
        if (file instanceof TFile) {
          this.debug("watcher delete", file.path);
          void this.enqueueSync(() => this.bridge!.onLocalDelete(file.path));
        }
      })
    );
  }

  private registerEditorChangeFallback() {
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.suppressWatcher || !this.bridge) return;
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        this.scheduleLocalFlush(file.path, "editor");
      })
    );
  }

  private scheduleLocalFlush(path: string, source: string) {
    const previous = this.modifyTimers.get(path);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.modifyTimers.delete(path);
      this.debug(`${source} flush`, path);
      void this.enqueueSync(async () => {
        if (source === "create") await this.bridge?.onLocalCreate(path);
        else await this.bridge?.onLocalModify(path);
      });
    }, LOCAL_CHANGE_DEBOUNCE_MS);
    this.modifyTimers.set(path, timer);
  }

  private enqueueSync(run: () => Promise<void>): Promise<void> {
    this.syncChain = this.syncChain.then(run).catch((error) => {
      console.error("[lapis] sync chain error", error);
    });
    return this.syncChain;
  }

  private openSettingsTab(): void {
    const app = this.app as typeof this.app & {
      setting?: { open(): Promise<void>; openTabById(id: string): Promise<void> };
    };
    void app.setting?.open().then(() => app.setting?.openTabById(this.manifest.id));
  }

  private debug(...args: unknown[]) {
    if (this.settings.debugLogging) {
      console.info("[lapis]", ...args);
    }
  }

  private async savePluginData() {
    await this.saveData({
      settings: this.settings,
      fsIndex: this.fsIndex,
      yjsStateBase64: this.yjsState ? bytesToBase64(this.yjsState.buffer.slice(
        this.yjsState.byteOffset,
        this.yjsState.byteOffset + this.yjsState.byteLength
      ) as ArrayBuffer) : null,
    } satisfies PluginData);
  }
}
