import { Circle, Users, Warning, X, FloppyDisk, Check } from "@phosphor-icons/react";
import type { PresenceEntry, SameFileWarning } from "../../hooks/useVaultNotify";

export type SyncState = "idle" | "saving" | "saved" | "dirty";

interface StatusBarProps {
  connected: boolean;
  presence: PresenceEntry[];
  sameFileWarning: SameFileWarning | null;
  onDismissWarning: () => void;
  /** Plain-text content of the active note, for word/char counts. */
  activeText: string | null;
  syncState: SyncState;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export default function StatusBar({
  connected,
  presence,
  sameFileWarning,
  onDismissWarning,
  activeText,
  syncState,
}: StatusBarProps) {
  const activeCount = presence.length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-secondary px-3 text-[11px] text-muted">
      {/* Connection / presence */}
      <span
        className="flex items-center gap-1"
        title={
          connected
            ? presence.map((p) => p.identity).join(", ") || "Connected"
            : "Reconnecting…"
        }
      >
        <Circle
          size={8}
          weight="fill"
          className={connected ? "text-success" : "text-faint"}
        />
        {connected ? (
          activeCount === 0 ? (
            "Only you"
          ) : (
            <span className="flex items-center gap-1">
              <Users size={12} weight="duotone" />
              {activeCount} connected
            </span>
          )
        ) : (
          "Reconnecting…"
        )}
      </span>

      {/* Same-file warning */}
      {sameFileWarning && (
        <span className="flex items-center gap-1 text-warning">
          <Warning size={12} weight="fill" />
          Also editing: <strong className="font-medium">{sameFileWarning.others.join(", ")}</strong>
          <button
            type="button"
            onClick={onDismissWarning}
            title="Dismiss"
            aria-label="Dismiss warning"
            className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded hover:bg-elevated hover:text-ink"
          >
            <X size={10} weight="bold" />
          </button>
        </span>
      )}

      <span className="flex-1" />

      {/* Sync state */}
      {syncState === "saving" && (
        <span className="flex items-center gap-1">
          <FloppyDisk size={12} weight="duotone" className="animate-pulse" />
          Saving…
        </span>
      )}
      {syncState === "saved" && (
        <span className="flex items-center gap-1 text-success">
          <Check size={12} weight="bold" />
          Saved
        </span>
      )}
      {syncState === "dirty" && (
        <span className="flex items-center gap-1 text-accent-soft">
          <Circle size={7} weight="fill" />
          Unsaved
        </span>
      )}

      {/* Counts */}
      {activeText != null && (
        <span className="flex items-center gap-3 font-mono">
          <span>{countWords(activeText)} words</span>
          <span>{activeText.length} chars</span>
        </span>
      )}
    </footer>
  );
}
