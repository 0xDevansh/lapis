import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type LapisPlugin from "./main";
import { DEFAULT_SETTINGS, type LapisSettings } from "./types";
import {
  applyVaultLinkToSettings,
  formatVaultLink,
  serverHostname,
  shortVaultId,
  vaultLinkDisplay,
} from "./vault-link";

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
    debugLogging: partial.debugLogging ?? false,
    lastConnectedAt: partial.lastConnectedAt ?? null,
    writable: partial.writable !== false,
    role:
      partial.role === "owner" || partial.role === "editor" || partial.role === "viewer"
        ? partial.role
        : undefined,
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
    containerEl.addClass("lapis-settings");

    containerEl.createEl("h2", { text: "Lapis sync" });

    if (this.plugin.settings.syncToken) {
      this.renderConnectedState(containerEl);
    } else {
      this.renderDisconnectedState(containerEl);
    }

    this.renderAdvancedSection(containerEl);
  }

  private renderDisconnectedState(containerEl: HTMLElement): void {
    const intro = containerEl.createDiv({ cls: "lapis-settings-intro" });
    intro.createEl("p", {
      text: "Paste the vault link from your browser, then approve this device on the web.",
    });

    const status = containerEl.createDiv({ cls: "lapis-settings-status lapis-settings-status--idle" });
    status.createSpan({ cls: "lapis-settings-status-dot" });
    status.createSpan({ text: " Not connected" });

    let linkInput = vaultLinkDisplay(this.plugin.settings);

    new Setting(containerEl)
      .setName("Vault link")
      .setDesc("Copy from your browser while viewing the vault (e.g. …/vault/your-id).")
      .addText((text) => {
        text
          .setPlaceholder("https://your-lapis-server.com/vault/…")
          .setValue(linkInput)
          .onChange((value) => {
            linkInput = value;
          });
      })
      .addButton((button) =>
        button
          .setIcon("link")
          .setTooltip("Apply link")
          .onClick(async () => {
            if (!applyVaultLinkToSettings(this.plugin.settings, linkInput)) {
              new Notice("Lapis: paste a full vault URL (https://…/vault/…)");
              return;
            }
            await this.plugin.saveSettings();
            this.display();
            new Notice("Lapis: vault link saved");
          })
      );

    new Setting(containerEl)
      .setName("Connect")
      .setDesc("Opens an approval code — enter it on the vault's Devices page in your browser.")
      .addButton((button) =>
        button
          .setButtonText("Connect to vault")
          .setCta()
          .onClick(async () => {
            if (linkInput.trim() && applyVaultLinkToSettings(this.plugin.settings, linkInput)) {
              await this.plugin.saveSettings();
            }
            void this.plugin.connect();
          })
      );
  }

  private renderConnectedState(containerEl: HTMLElement): void {
    const { settings } = this.plugin;
    const host = serverHostname(settings.serverUrl);
    const vault = shortVaultId(settings.vaultId);
    const since = settings.lastConnectedAt
      ? new Date(settings.lastConnectedAt).toLocaleString()
      : "recently";

    const status = containerEl.createDiv({ cls: "lapis-settings-status lapis-settings-status--connected" });
    status.createSpan({ cls: "lapis-settings-status-dot" });
    status.createSpan({ text: settings.writable === false ? " Connected · read-only" : " Connected" });

    const card = containerEl.createDiv({ cls: "lapis-settings-card" });
    card.createEl("div", { cls: "lapis-settings-card-row", text: `Server: ${host}` });
    card.createEl("div", { cls: "lapis-settings-card-row", text: `Vault: ${vault}` });
    card.createEl("div", { cls: "lapis-settings-card-row", text: `Device: ${settings.deviceName}` });
    card.createEl("div", {
      cls: "lapis-settings-card-row",
      text: settings.writable === false ? "Access: read-only" : "Access: read and write",
    });
    card.createEl("div", { cls: "lapis-settings-card-row lapis-settings-card-muted", text: `Since ${since}` });

    if (settings.serverUrl && settings.vaultId) {
      const linkRow = card.createDiv({ cls: "lapis-settings-card-row lapis-settings-card-muted" });
      linkRow.createEl("span", { text: formatVaultLink(settings.serverUrl, settings.vaultId) });
    }

    new Setting(containerEl)
      .setName("Actions")
      .addButton((button) =>
        button.setButtonText("Sync now").onClick(() => void this.plugin.syncNow())
      )
      .addButton((button) =>
        button.setButtonText("Disconnect").onClick(() => void this.plugin.disconnect())
      );
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "lapis-settings-advanced" });
    details.createEl("summary", { text: "Advanced" });

    new Setting(details)
      .setName("Device name")
      .setDesc("Shown in the web vault's device list.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim() || defaultDeviceName();
            await this.plugin.saveSettings();
          })
      );

    if (!this.plugin.settings.syncToken) {
      new Setting(details)
        .setName("Server URL")
        .setDesc("Only needed if you prefer separate fields instead of a vault link.")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:8787")
            .setValue(this.plugin.settings.serverUrl)
            .onChange(async (value) => {
              this.plugin.settings.serverUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(details)
        .setName("Vault ID")
        .setDesc("The ID from the vault URL, if not using a full link.")
        .addText((text) =>
          text
            .setPlaceholder("vault id")
            .setValue(this.plugin.settings.vaultId)
            .onChange(async (value) => {
              this.plugin.settings.vaultId = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(details)
      .setName("Receive Vault Internals")
      .setDesc("Also sync .obsidian and other vault-internal files.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.receiveInternals)
          .setDisabled(!this.plugin.settings.syncToken)
          .onChange(async (value) => this.plugin.setReceiveInternals(value))
      );

    new Setting(details)
      .setName("Debug logging")
      .setDesc("Log sync activity to the developer console (Ctrl+Shift+I).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
