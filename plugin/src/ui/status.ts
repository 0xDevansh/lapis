import type { LapisSettings } from "../types";

export class LapisStatusBar {
  constructor(private readonly element: HTMLElement) {}

  update(settings: LapisSettings, state: "idle" | "connecting" | "syncing" | "error" = "idle", conflictCount = 0) {
    this.element.toggleClass("lapis-status-conflicts", conflictCount > 0);
    const conflicts = conflictCount > 0 ? ` (${conflictCount} conflict${conflictCount === 1 ? "" : "s"})` : "";
    if (state === "connecting") {
      this.element.setText(`Lapis: connecting...${conflicts}`);
      return;
    }
    if (state === "syncing") {
      this.element.setText(`Lapis: syncing...${conflicts}`);
      return;
    }
    if (state === "error") {
      this.element.setText(`Lapis: error — run Sync now${conflicts}`);
      return;
    }

    this.element.setText(`${settings.syncToken ? "Lapis: connected" : "Lapis: not connected"}${conflicts}`);
  }

  offline(pendingCount: number, conflictCount = 0) {
    this.element.toggleClass("lapis-status-conflicts", conflictCount > 0);
    const conflicts = conflictCount > 0 ? `, ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}` : "";
    this.element.setText(`Lapis: offline (${pendingCount} pending${conflicts})`);
  }
}

export function countConflicts(paths: string[]): number {
  return paths.filter((path) => path.toLowerCase().startsWith(".sync-conflicts/")).length;
}
