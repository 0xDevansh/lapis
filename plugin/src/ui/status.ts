import type { LapisSettings } from "../types";
import { serverHostname, shortVaultId } from "../vault-link";

export class LapisStatusBar {
  constructor(private readonly element: HTMLElement) {}

  update(settings: LapisSettings, state: "idle" | "connecting" | "syncing" | "error" = "idle", conflictCount = 0) {
    this.element.toggleClass("lapis-status-conflicts", conflictCount > 0);
    const conflicts = conflictCount > 0 ? ` (${conflictCount} conflict${conflictCount === 1 ? "" : "s"})` : "";
    const connectedLabel =
      settings.syncToken && settings.serverUrl
        ? `Lapis: ${serverHostname(settings.serverUrl)}`
        : settings.syncToken
          ? "Lapis: connected"
          : "Lapis: not connected";

    if (state === "connecting") {
      this.element.setText(`Lapis: connecting…${conflicts}`);
      return;
    }
    if (state === "syncing") {
      const vault = settings.vaultId ? ` · ${shortVaultId(settings.vaultId)}` : "";
      this.element.setText(`${connectedLabel}${vault} · syncing…${conflicts}`);
      return;
    }
    if (state === "error") {
      this.element.setText(`${connectedLabel} · error${conflicts}`);
      return;
    }

    if (settings.syncToken && settings.vaultId) {
      this.element.setText(`${connectedLabel} · ${shortVaultId(settings.vaultId)}${conflicts}`);
      return;
    }

    this.element.setText(`${connectedLabel}${conflicts}`);
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
