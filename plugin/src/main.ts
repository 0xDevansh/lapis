import { Notice, Plugin, TFile } from "obsidian";
import { LapisClient } from "./net/client";
import { NotifyClient, type NotifyMessage } from "./net/notify";
import { LapisSettingTab, normalizeSettings } from "./settings";
import type { LapisSettings, PluginData, SyncJournal } from "./types";
import { SyncEngine } from "./sync/engine";
import { isValidJournal } from "./sync/journal";
import { ConnectModal } from "./ui/connect-modal";
import { countConflicts, LapisStatusBar } from "./ui/status";

const LOCAL_CHANGE_DEBOUNCE_MS = 5_000;

export default class LapisPlugin extends Plugin {
  settings!: LapisSettings;
  journal: SyncJournal | null = null;
  settingTab!: LapisSettingTab;
  private statusBar!: LapisStatusBar;
  private modifyTimers = new Map<string, number>();
  private suppressWatcher = false;
  private notifyClient: NotifyClient | null = null;
  private lastPresenceCount = 0;
  private currentOpenPath: string | null = null;

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
      id: "open-conflicts-folder",
      name: "Open conflicts folder",
      callback: () => this.openConflictsFolder(),
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
    this.startNotify();
    this.registerInterval(window.setInterval(() => void this.pullChanged(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.reportOpenFile(), 2000));
  }

  onunload() {
    this.notifyClient?.close();
  }

  async loadSettings() {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = normalizeSettings(data?.settings ?? data);
    this.journal = isValidJournal(data?.journal, this.settings.vaultId) ? data.journal : null;
  }

  async saveSettings() {
    await this.savePluginData();
    this.updateStatus();
  }

  refreshSettingsTab() {
    this.settingTab?.display();
  }

  async saveJournal(journal: SyncJournal) {
    this.journal = journal;
    await this.savePluginData();
    this.updateStatus();
  }

  async connect() {
    if (!this.settings.serverUrl.trim()) {
      new Notice("Lapis: set a server URL first");
      return;
    }
    if (!this.settings.vaultId.trim()) {
      new Notice("Lapis: set a Web Vault ID first");
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
        challenge,
        fetchToken: (deviceCode) => client.pollDeviceToken(deviceCode),
        onConnected: async ({ token, deviceId }) => {
          this.settings.syncToken = token;
          this.settings.deviceId = deviceId;
          this.settings.lastConnectedAt = new Date().toISOString();
          await this.saveSettings();
          this.refreshSettingsTab();
          this.startNotify();
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
    this.settings.syncToken = "";
    this.settings.deviceId = "";
    this.settings.lastConnectedAt = null;
    this.journal = null;
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
        await new LapisClient(this.settings.serverUrl).updateDevice(this.settings.vaultId, this.settings.syncToken, receiveInternals);
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

    this.updateStatus("syncing");
    const previousSuppress = this.suppressWatcher;
    this.suppressWatcher = true;
    const engine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      client: new LapisClient(this.settings.serverUrl),
      getJournal: () => this.journal,
      setJournal: (journal) => this.saveJournal(journal),
    });
    try {
      if (this.journal) {
        await engine.replayPending();
        const { pushed, deleted } = await engine.pushLocalChanges();
        await engine.pullChanged();
        if (pushed > 0 || deleted > 0) {
          new Notice(`Lapis: pushed ${pushed} change${pushed === 1 ? "" : "s"}${deleted > 0 ? ` and ${deleted} delete${deleted === 1 ? "" : "s"}` : ""}`);
        } else {
          new Notice("Lapis: sync complete");
        }
      } else {
        await engine.firstSync();
      }
      this.updateStatus();
    } catch (error) {
      this.updateStatus("error");
      const message = error instanceof Error ? error.message : "Sync failed";
      new Notice(`Lapis: ${message}`);
    } finally {
      this.suppressWatcher = previousSuppress;
    }
  }

  private async pullChanged() {
    if (!this.settings.syncToken || !this.journal) {
      return;
    }
    await this.runSync((engine) => engine.pullChanged(), true);
  }

  private openConflictsFolder() {
    const folder = this.app.vault.getAbstractFileByPath(".sync-conflicts");
    if (folder) {
      (this.app.workspace as unknown as { revealInFolder(file: unknown): void }).revealInFolder(folder);
    } else {
      new Notice("Lapis: no conflict notes");
    }
  }

  private async showSyncDiagnostics() {
    const engine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      client: new LapisClient(this.settings.serverUrl),
      getJournal: () => this.journal,
      setJournal: (journal) => this.saveJournal(journal),
    });
    try {
      const diagnostics = await engine.diagnostics();
      console.info("[lapis] sync diagnostics", diagnostics);
      if (diagnostics.changedPaths.length > 0) {
        console.info("[lapis] changed paths", diagnostics.changedPaths);
      }
      if (diagnostics.deletedPaths.length > 0) {
        console.info("[lapis] deleted paths", diagnostics.deletedPaths);
      }
      new Notice(
        `Lapis diagnostics: local ${diagnostics.localFileCount}, server ${diagnostics.serverFileCount ?? "?"}, changed ${diagnostics.changedPaths.length}, pending ${diagnostics.pendingOpCount}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Diagnostics failed";
      console.error("[lapis] sync diagnostics failed", error);
      new Notice(`Lapis: ${message}`);
    }
  }

  private updateStatus(state: "idle" | "connecting" | "syncing" | "error" = "idle") {
    this.statusBar?.update(this.settings, state, this.conflictCount());
  }

  private conflictCount(): number {
    const journalPaths = this.journal ? Object.keys(this.journal.fileRevisions) : [];
    const localPaths = this.app.vault.getFiles().map((file) => file.path);
    return countConflicts([...journalPaths, ...localPaths]);
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
        if (reconnected) this.debug("notify reconnected");
        this.reportOpenFile(true);
      },
      onClose: () => this.statusBar.offline(this.journal?.pendingOps.length ?? 0, this.conflictCount()),
      onMessage: (message) => this.handleNotifyMessage(message),
    });
    this.notifyClient.connect();
  }

  private async handleNotifyMessage(message: NotifyMessage) {
    if (message.type === "change") {
      if (message.author === `device:${this.settings.deviceId}`) {
        return;
      }
      if (message.kind === "put" && this.journal?.fileRevisions[message.path.toLowerCase()] === message.revision) {
        return;
      }
      if (message.kind === "put") {
        await this.runSync((engine) => engine.applyRemotePut(message.path, message.revision, message.patch, message.baseRevision), true);
      } else if (message.kind === "rename" && message.newPath) {
        const newPath = message.newPath;
        await this.runSync((engine) => engine.applyRemoteRename(message.path, newPath), true);
      } else if (message.kind === "delete") {
        await this.runSync((engine) => engine.applyRemoteDelete(message.path), true);
      }
      return;
    }

    if (message.type === "presence") {
      const others = message.sessions.filter((session) => !session.identity.startsWith(`device:${this.settings.deviceName}`));
      if (this.lastPresenceCount !== 0 && others.length !== this.lastPresenceCount) {
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
    if (nextPath) {
      this.notifyClient?.sendOpen(nextPath);
    } else {
      this.notifyClient?.sendCloseFile();
    }
  }

  private registerWatcher() {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          this.scheduleLocalFlush(file.path, "watcher create");
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          this.scheduleLocalFlush(file.path, "watcher modify");
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          this.debug("watcher rename", oldPath, "->", file.path);
          void this.runSync((engine) => engine.pushRename(oldPath, file.path), false, (engine) => engine.queueRename(oldPath, file.path));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          this.debug("watcher delete", file.path);
          void this.runSync((engine) => engine.pushDelete(file.path), false, (engine) => engine.queueDelete(file.path));
        }
      })
    );
  }

  private registerEditorChangeFallback() {
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.suppressWatcher) return;
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        this.scheduleLocalFlush(file.path, "editor change");
      })
    );
  }

  private scheduleLocalFlush(path: string, source: string) {
    const previous = this.modifyTimers.get(path);
    if (previous) {
      window.clearTimeout(previous);
    }
    const timer = window.setTimeout(() => {
      this.modifyTimers.delete(path);
      this.debug(`${source} flush`, path);
      void this.runSync((engine) => engine.pushPut(path), false, (engine) => engine.queuePut(path));
    }, LOCAL_CHANGE_DEBOUNCE_MS);
    this.modifyTimers.set(path, timer);
  }

  private async runSync(action: (engine: SyncEngine) => Promise<void>, suppressWatcher = false, onFailure?: (engine: SyncEngine) => Promise<void>) {
    if (!this.settings.syncToken) {
      return;
    }
    this.updateStatus("syncing");
    const previousSuppress = this.suppressWatcher;
    this.suppressWatcher = previousSuppress || suppressWatcher;
    try {
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        client: new LapisClient(this.settings.serverUrl),
        getJournal: () => this.journal,
        setJournal: (journal) => this.saveJournal(journal),
      });
      await action(engine);
      this.updateStatus();
    } catch (error) {
      if (onFailure) {
        const engine = new SyncEngine({
          app: this.app,
          settings: this.settings,
          client: new LapisClient(this.settings.serverUrl),
          getJournal: () => this.journal,
          setJournal: (journal) => this.saveJournal(journal),
        });
        await onFailure(engine);
        this.statusBar.offline(this.journal?.pendingOps.length ?? 0, this.conflictCount());
        return;
      }
      this.updateStatus("error");
      const message = error instanceof Error ? error.message : "Sync failed";
      console.error("[lapis] sync failed", error);
      new Notice(`Lapis: ${message}`);
    } finally {
      this.suppressWatcher = previousSuppress;
    }
  }

  private debug(...args: unknown[]) {
    if (this.settings.debugLogging) {
      console.info("[lapis]", ...args);
    }
  }

  private async savePluginData() {
    await this.saveData({ settings: this.settings, journal: this.journal } satisfies PluginData);
  }
}
