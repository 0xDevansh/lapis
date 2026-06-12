import { Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import { pollDeviceToken } from "../net/device-auth";
import type { DeviceAuthChallenge } from "../types";

interface ConnectModalOptions {
  serverUrl: string;
  challenge: DeviceAuthChallenge;
  fetchToken: (deviceCode: string) => Promise<{ status: "pending" } | { status: "approved"; token: string; deviceId: string } | { status: "denied" | "expired" | "not_found" }>;
  onConnected: (connection: { token: string; deviceId: string }) => Promise<void>;
  onDone?: () => void;
}

export class ConnectModal extends Modal {
  private controller = new AbortController();

  constructor(app: App, private readonly options: ConnectModalOptions) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect to Lapis" });
    contentEl.createEl("p", { text: "Approve this device in your Web Vault using this code:" });
    contentEl.createEl("div", { cls: "lapis-user-code", text: this.options.challenge.userCode });

    const link = contentEl.createEl("a", {
      text: "Open approval page",
      href: this.verificationUrl(),
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noreferrer");

    const status = contentEl.createEl("p", { text: "Waiting for approval..." });
    const spinner = contentEl.createDiv({ cls: "lapis-connecting-spinner" });
    setIcon(spinner, "loader");

    void pollDeviceToken({
      deviceCode: this.options.challenge.deviceCode,
      fetchToken: this.options.fetchToken,
      signal: this.controller.signal,
    })
      .then(async (connection) => {
        status.setText("Connected.");
        await this.options.onConnected(connection);
        new Notice("Lapis: connected");
        this.close();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Connection failed";
        if (message !== "Connection cancelled") {
          new Notice(`Lapis: ${message.toLowerCase()}`);
        }
        status.setText(message);
      });
  }

  onClose() {
    this.controller.abort();
    this.contentEl.empty();
    this.options.onDone?.();
  }

  private verificationUrl(): string {
    if (/^https?:\/\//.test(this.options.challenge.verificationUri)) {
      return this.options.challenge.verificationUri;
    }
    return `${this.options.serverUrl.replace(/\/$/, "")}${this.options.challenge.verificationUri}`;
  }
}
