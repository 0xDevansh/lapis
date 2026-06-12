import type { LapisSettings } from "../types";

export class LapisStatusBar {
  constructor(private readonly element: HTMLElement) {}

  update(settings: LapisSettings, state: "idle" | "connecting" = "idle") {
    if (state === "connecting") {
      this.element.setText("Lapis: connecting...");
      return;
    }

    this.element.setText(settings.syncToken ? "Lapis: connected" : "Lapis: not connected");
  }
}
