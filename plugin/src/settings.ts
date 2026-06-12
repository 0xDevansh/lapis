import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type LapisPlugin from "./main";
import { DEFAULT_SETTINGS, type LapisSettings } from "./types";

export function normalizeSettings(data: unknown): LapisSettings {
  const partial = typeof data === "object" && data !== null ? (data as Partial<LapisSettings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    serverUrl: partial.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
    vaultId: partial.vaultId ?? "",
    syncToken: partial.syncToken ?? "",
    deviceId: partial.deviceId ?? "",
    deviceName: partial.deviceName ?? defaultDeviceName(),
    receiveInternals: partial.receiveInternals ?? false,
    lastConnectedAt: partial.lastConnectedAt ?? null,
  };
}

export function defaultDeviceName(): string {
  return `Obsidian on ${navigator.platform || "this device"}`;
}

export class LapisSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LapisPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Lapis sync" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The base URL of your deployed Lapis Worker.")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8787")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Web Vault ID")
      .setDesc("The vault ID from the Web Vault URL.")
      .addText((text) =>
        text
          .setPlaceholder("vault_...")
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in the Lapis devices list.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim() || defaultDeviceName();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Receive Vault Internals")
      .setDesc("Also sync Vault Internals such as .obsidian data for this device.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.receiveInternals)
          .setDisabled(!this.plugin.settings.syncToken)
          .onChange(async (value) => this.plugin.setReceiveInternals(value))
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(this.plugin.settings.syncToken ? `Connected${this.plugin.settings.lastConnectedAt ? ` since ${this.plugin.settings.lastConnectedAt}` : ""}` : "Not connected")
      .addButton((button) => {
        if (this.plugin.settings.syncToken) {
          button.setButtonText("Disconnect").onClick(() => void this.plugin.disconnect());
        } else {
          button.setButtonText("Connect").setCta().onClick(() => void this.plugin.connect());
        }
      });
  }
}
