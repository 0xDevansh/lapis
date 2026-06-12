import { Notice, Plugin } from "obsidian";
import { LapisClient } from "./net/client";
import { LapisSettingTab, normalizeSettings } from "./settings";
import type { LapisSettings } from "./types";
import { ConnectModal } from "./ui/connect-modal";
import { LapisStatusBar } from "./ui/status";

export default class LapisPlugin extends Plugin {
  settings!: LapisSettings;
  private statusBar!: LapisStatusBar;

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

    this.addSettingTab(new LapisSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.statusBar?.update(this.settings);
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
    await this.saveSettings();
    new Notice("Lapis: disconnected");
  }
}
