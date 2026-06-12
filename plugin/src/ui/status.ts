import type { LapisSettings } from "../types";

export class LapisStatusBar {
  constructor(private readonly element: HTMLElement) {}

  update(settings: LapisSettings, state: "idle" | "connecting" | "syncing" | "error" = "idle") {
    if (state === "connecting") {
      this.element.setText("Lapis: connecting...");
      return;
    }
    if (state === "syncing") {
      this.element.setText("Lapis: syncing...");
      return;
    }
    if (state === "error") {
      this.element.setText("Lapis: error — run Sync now");
      return;
    }

    this.element.setText(settings.syncToken ? "Lapis: connected" : "Lapis: not connected");
  }

  offline(pendingCount: number) {
    this.element.setText(`Lapis: offline (${pendingCount} pending)`);
  }
}
