import { Notice, Plugin, TFile } from "obsidian";
import { LapisClient } from "./net/client";
import { LapisSettingTab, normalizeSettings } from "./settings";
import type { LapisSettings, PluginData, SyncJournal } from "./types";
import { SyncEngine } from "./sync/engine";
import { isValidJournal } from "./sync/journal";
import { ConnectModal } from "./ui/connect-modal";
import { LapisStatusBar } from "./ui/status";

export default class LapisPlugin extends Plugin {
  settings!: LapisSettings;
  journal: SyncJournal | null = null;
  private statusBar!: LapisStatusBar;
  private modifyTimers = new Map<string, number>();
  private suppressWatcher = false;

  async onload() {
    await this.loadSettings();

    this.statusBar = new LapisStatusBar(this.addStatusBarItem());
    this.statusBar.update(this.settings);

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

    this.addSettingTab(new LapisSettingTab(this.app, this));
    this.registerWatcher();
    this.registerInterval(window.setInterval(() => void this.pullChanged(), 5 * 60 * 1000));
  }

  async loadSettings() {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = normalizeSettings(data?.settings ?? data);
    this.journal = isValidJournal(data?.journal, this.settings.vaultId) ? data.journal : null;
  }

  async saveSettings() {
    await this.savePluginData();
    this.statusBar?.update(this.settings);
  }

  async saveJournal(journal: SyncJournal) {
    this.journal = journal;
    await this.savePluginData();
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

    this.statusBar.update(this.settings, "connecting");
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
        onConnected: async (token) => {
          this.settings.syncToken = token;
          this.settings.lastConnectedAt = new Date().toISOString();
          await this.saveSettings();
          await this.syncNow();
        },
        onDone: () => this.statusBar.update(this.settings),
      }).open();
    } catch (error) {
      this.statusBar.update(this.settings);
      const message = error instanceof Error ? error.message : "Connection failed";
      new Notice(`Lapis: ${message}`);
    }
  }

  async disconnect() {
    this.settings.syncToken = "";
    this.settings.lastConnectedAt = null;
    this.journal = null;
    await this.saveSettings();
    new Notice("Lapis: disconnected");
  }

  async syncNow() {
    this.statusBar.update(this.settings, "syncing");
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
        await engine.pullChanged();
      } else {
        await engine.firstSync();
      }
      this.statusBar.update(this.settings);
    } catch (error) {
      this.statusBar.update(this.settings, "error");
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

  private registerWatcher() {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          void this.runSync((engine) => engine.pushPut(file.path), false, (engine) => engine.queuePut(file.path));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          const previous = this.modifyTimers.get(file.path);
          if (previous) {
            window.clearTimeout(previous);
          }
          const timer = window.setTimeout(() => {
            this.modifyTimers.delete(file.path);
            void this.runSync((engine) => engine.pushPut(file.path), false, (engine) => engine.queuePut(file.path));
          }, 500);
          this.modifyTimers.set(file.path, timer);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          void this.runSync((engine) => engine.pushRename(oldPath, file.path), false, (engine) => engine.queueRename(oldPath, file.path));
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.suppressWatcher) return;
        if (file instanceof TFile) {
          void this.runSync((engine) => engine.pushDelete(file.path), false, (engine) => engine.queueDelete(file.path));
        }
      })
    );
  }

  private async runSync(action: (engine: SyncEngine) => Promise<void>, suppressWatcher = false, onFailure?: (engine: SyncEngine) => Promise<void>) {
    if (!this.settings.syncToken) {
      return;
    }
    this.statusBar.update(this.settings, "syncing");
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
      this.statusBar.update(this.settings);
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
        this.statusBar.offline(this.journal?.pendingOps.length ?? 0);
        return;
      }
      this.statusBar.update(this.settings, "error");
      const message = error instanceof Error ? error.message : "Sync failed";
      new Notice(`Lapis: ${message}`);
    } finally {
      this.suppressWatcher = previousSuppress;
    }
  }

  private async savePluginData() {
    await this.saveData({ settings: this.settings, journal: this.journal } satisfies PluginData);
  }
}
