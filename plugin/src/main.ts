import { Notice, Plugin, TFile } from "obsidian";
import { LapisClient } from "./net/client";
import { NotifyClient, type NotifyMessage } from "./net/notify";
import { LapisSettingTab, normalizeSettings } from "./settings";
import type {
  ConflictPayload,
  ConflictResolutionRequest,
  LapisSettings,
  PluginData,
  SyncJournal,
} from "./types";
import { SyncEngine, type SyncProgress } from "./sync/engine";
import { isValidJournal } from "./sync/journal";
import { ConnectModal } from "./ui/connect-modal";
import { ConflictModal } from "./ui/conflict-modal";
import { countConflicts, LapisStatusBar } from "./ui/status";
import { deviceAuthor } from "./identity";
import { PluginDevice } from "./device/plugin-device";
import { isVaultInternal } from "./sync/paths";

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
  private syncChain: Promise<void> = Promise.resolve();
  private conflicts: ConflictPayload[] = [];

  async onload() {
    await this.loadSettings();

    this.statusBar = new LapisStatusBar(
      this.addStatusBarItem(),
      () => void this.openConflictResolver()
    );
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
      id: "force-full-reconcile",
      name: "Force full reconcile",
      callback: () => void this.forceFullReconcile(),
    });

    this.addCommand({
      id: "open-conflicts-folder",
      name: "Open conflicts folder",
      callback: () => this.openConflictsFolder(),
    });

    this.addCommand({
      id: "resolve-sync-conflicts",
      name: "Resolve sync conflicts",
      callback: () => void this.openConflictResolver(),
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
    this.refreshConflictsQuietly();
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
        onConnected: async ({ token, deviceId }, onProgress) => {
          this.settings.syncToken = token;
          this.settings.deviceId = deviceId;
          this.settings.lastConnectedAt = new Date().toISOString();
          await this.saveSettings();
          this.refreshSettingsTab();
          await this.syncNow(onProgress);
          this.startNotify();
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
    this.conflicts = [];
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

  async syncNow(onProgress?: (progress: SyncProgress) => void) {
    if (!this.settings.syncToken) {
      new Notice("Lapis: connect before syncing");
      return;
    }

    onProgress?.({
      phase: "scanning",
      current: 0,
      total: 0,
      message: "Starting sync…",
    });
    await this.enqueueSync(async () => {
      this.updateStatus("syncing");
      const previousSuppress = this.suppressWatcher;
      this.suppressWatcher = true;
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        client: new LapisClient(this.settings.serverUrl),
        getJournal: () => this.journal,
        setJournal: (journal) => this.saveJournal(journal),
        onProgress,
      });
      try {
        if (this.journal) {
          await engine.replayPending();
          const { pushed, deleted } = await engine.pushLocalChanges();
          await engine.pullChanged();
          await engine.completePendingSeed();
          if (pushed > 0 || deleted > 0) {
            new Notice(`Lapis: pushed ${pushed} change${pushed === 1 ? "" : "s"}${deleted > 0 ? ` and ${deleted} delete${deleted === 1 ? "" : "s"}` : ""}`);
          } else {
            new Notice("Lapis: sync complete");
          }
        } else {
          await engine.firstSync();
        }
        await this.refreshConflicts();
        this.updateStatus();
      } catch (error) {
        this.updateStatus("error");
        const message = error instanceof Error ? error.message : "Sync failed";
        new Notice(`Lapis: ${message}`);
        if (onProgress) throw error;
      } finally {
        this.suppressWatcher = previousSuppress;
      }
    }, Boolean(onProgress));
  }

  async forceFullReconcile(): Promise<void> {
    if (!this.settings.syncToken) {
      new Notice("Lapis: connect before syncing");
      return;
    }

    const progressNotice = new Notice("Lapis: starting full reconcile…", 0);
    await this.enqueueSync(async () => {
      this.updateStatus("syncing");
      const previousSuppress = this.suppressWatcher;
      this.suppressWatcher = true;
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        client: new LapisClient(this.settings.serverUrl),
        getJournal: () => this.journal,
        setJournal: (journal) => this.saveJournal(journal),
        onProgress: (progress) => {
          progressNotice.setMessage(`Lapis: ${progress.message}`);
        },
      });
      try {
        await engine.forceReconcile();
        await this.refreshConflicts();
        this.updateStatus();
        progressNotice.setMessage("Lapis: full reconcile complete");
        window.setTimeout(() => progressNotice.hide(), 3_000);
      } catch (error) {
        this.updateStatus("error");
        const message = error instanceof Error ? error.message : "Full reconcile failed";
        progressNotice.setMessage(`Lapis: ${message}`);
        window.setTimeout(() => progressNotice.hide(), 8_000);
        console.error("[lapis] full reconcile failed", error);
      } finally {
        this.suppressWatcher = previousSuppress;
      }
    });
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

  private async openConflictResolver(): Promise<void> {
    if (!this.settings.syncToken) {
      new Notice("Lapis: connect before resolving conflicts");
      return;
    }
    try {
      await this.refreshConflicts();
      if (this.conflicts.length === 0) {
        new Notice("Lapis: no unresolved sync conflicts");
        return;
      }
      new ConflictModal(this.app, {
        conflicts: this.conflicts,
        onResolve: (request) => this.resolveConflict(request),
        onOpenNote: (path) => this.openConflictNote(path),
      }).open();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load conflicts";
      new Notice(`Lapis: ${message}`);
    }
  }

  private async openConflictNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("Lapis: conflict note is not available locally");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async resolveConflict(
    request: ConflictResolutionRequest
  ): Promise<void> {
    await this.enqueueSync(async () => {
      const previousSuppress = this.suppressWatcher;
      this.suppressWatcher = true;
      try {
        const device = new PluginDevice({
          app: this.app,
          settings: this.settings,
          getJournal: () => this.journal,
          setJournal: (journal) => this.saveJournal(journal),
          notifyClient: this.notifyClient,
        });
        await device.resolveConflict(request);
        this.conflicts = this.conflicts.filter(
          (conflict) => conflict.conflictNote !== request.conflictNote
        );
        this.updateStatus();
      } finally {
        this.suppressWatcher = previousSuppress;
      }
    }, true);
  }

  private async refreshConflicts(): Promise<void> {
    if (!this.settings.syncToken || !this.settings.vaultId) {
      this.conflicts = [];
      this.updateStatus();
      return;
    }
    const client = new LapisClient(this.settings.serverUrl);
    this.conflicts = await client.getConflicts(
      this.settings.vaultId,
      this.settings.syncToken
    );
    this.updateStatus();
  }

  private refreshConflictsQuietly(): void {
    void this.refreshConflicts().catch((error) => {
      console.warn("[lapis] could not refresh conflicts", error);
    });
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
    return Math.max(
      this.conflicts.length,
      countConflicts([...journalPaths, ...localPaths])
    );
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
        this.refreshConflictsQuietly();
      },
      onClose: () => this.statusBar.offline(this.journal?.pendingOps.length ?? 0, this.conflictCount()),
      onMessage: (message) => this.handleNotifyMessage(message),
    });
    this.notifyClient.connect();
  }

  private async handleNotifyMessage(message: NotifyMessage) {
    if (message.type === "change") {
      if (
        isVaultInternal(message.path) &&
        !this.settings.receiveInternals
      ) {
        return;
      }
      if (message.author === deviceAuthor("plugin", this.settings.deviceId)) {
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
      const selfIdentity = deviceAuthor("plugin", this.settings.deviceId);
      const others = message.sessions.filter((session) => session.identity !== selfIdentity);
      if (this.lastPresenceCount !== 0 && others.length !== this.lastPresenceCount) {
        new Notice(`Lapis: ${others.length} other session${others.length === 1 ? "" : "s"} connected`);
      }
      this.lastPresenceCount = others.length;
      return;
    }

    if (message.type === "same_file_warning") {
      new Notice(`Lapis: another session is editing ${message.path}`);
      return;
    }

    if (message.type === "conflict") {
      if (
        isVaultInternal(message.conflict.path) &&
        !this.settings.receiveInternals
      ) {
        return;
      }
      const index = this.conflicts.findIndex(
        (conflict) =>
          conflict.conflictNote === message.conflict.conflictNote
      );
      if (index >= 0) {
        this.conflicts[index] = message.conflict;
      } else {
        this.conflicts.push(message.conflict);
      }
      this.updateStatus();
      new Notice(
        `Lapis: sync conflict in ${message.conflict.path}. Use “Resolve sync conflicts” to review it.`,
        8_000
      );
      return;
    }

    if (message.type === "conflict_resolved") {
      if (
        isVaultInternal(message.path) &&
        !this.settings.receiveInternals
      ) {
        return;
      }
      this.conflicts = this.conflicts.filter(
        (conflict) => conflict.conflictNote !== message.conflictNote
      );
      this.updateStatus();
      new Notice(`Lapis: conflict resolved for ${message.path}`);
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

  private enqueueSync(run: () => Promise<void>, propagateError = false): Promise<void> {
    const queued = this.syncChain.then(run);
    this.syncChain = queued.catch((error) => {
      console.error("[lapis] sync chain error", error);
    });
    return propagateError ? queued : this.syncChain;
  }

  private async runSync(action: (engine: SyncEngine) => Promise<void>, suppressWatcher = false, onFailure?: (engine: SyncEngine) => Promise<void>) {
    if (!this.settings.syncToken) {
      return;
    }
    await this.enqueueSync(async () => {
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
    });
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
    await this.saveData({ settings: this.settings, journal: this.journal } satisfies PluginData);
  }
}
