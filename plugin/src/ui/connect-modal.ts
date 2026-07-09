import { Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import { pollDeviceToken } from "../net/device-auth";
import type { DeviceAuthChallenge } from "../types";
import { serverHostname, shortVaultId } from "../vault-link";

interface ConnectModalOptions {
  serverUrl: string;
  vaultId: string;
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
    contentEl.addClass("lapis-connect-modal");

    contentEl.createEl("h2", { text: "Approve this device" });
    contentEl.createEl("p", {
      cls: "lapis-connect-modal-context",
      text: `${serverHostname(this.options.serverUrl)} · vault ${shortVaultId(this.options.vaultId)}`,
    });

    const steps = contentEl.createEl("ol", { cls: "lapis-connect-steps" });
    steps.createEl("li", { text: "Open the approval page in your browser (button below)." });
    steps.createEl("li", { text: "Enter the code shown here when prompted." });
    steps.createEl("li", { text: "Click Approve — this window closes automatically." });

    const codeRow = contentEl.createDiv({ cls: "lapis-user-code-row" });
    codeRow.createEl("div", { cls: "lapis-user-code", text: this.options.challenge.userCode });

    const copyBtn = codeRow.createEl("button", { cls: "mod-cta", text: "Copy code" });
    copyBtn.addEventListener("click", () => void this.copyCode(copyBtn));

    const link = contentEl.createEl("a", {
      cls: "lapis-connect-approval-link mod-cta",
      text: "Open approval page",
      href: this.verificationUrl(),
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noreferrer");

    const status = contentEl.createEl("p", { cls: "lapis-connect-status", text: "Waiting for approval…" });
    const spinner = contentEl.createDiv({ cls: "lapis-connecting-spinner" });
    setIcon(spinner, "loader");

    void pollDeviceToken({
      deviceCode: this.options.challenge.deviceCode,
      fetchToken: this.options.fetchToken,
      signal: this.controller.signal,
    })
      .then(async (connection) => {
        status.setText("Approved — syncing…");
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

  private async copyCode(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.options.challenge.userCode);
      const original = button.textContent;
      button.textContent = "Copied!";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1500);
    } catch {
      new Notice("Lapis: could not copy — select the code manually");
    }
  }

  private verificationUrl(): string {
    if (/^https?:\/\//.test(this.options.challenge.verificationUri)) {
      return this.options.challenge.verificationUri;
    }
    return `${this.options.serverUrl.replace(/\/$/, "")}${this.options.challenge.verificationUri}`;
  }
}
