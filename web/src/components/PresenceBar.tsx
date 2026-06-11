/**
 * PresenceBar — Slice 10.
 *
 * Shows:
 * - Live connection status (green dot / grey dot)
 * - How many sessions/devices are currently connected
 * - Same-file editing warning (dismissible)
 *
 * Presence never blocks editing.
 */

import React from "react";
import type { PresenceEntry, SameFileWarning } from "../hooks/useVaultNotify";

interface PresenceBarProps {
  connected: boolean;
  presence: PresenceEntry[];
  sameFileWarning: SameFileWarning | null;
  onDismissWarning: () => void;
}

export default function PresenceBar({
  connected,
  presence,
  sameFileWarning,
  onDismissWarning,
}: PresenceBarProps) {
  const activeCount = presence.length;

  return (
    <div className="presence-bar">
      {/* Connection status */}
      <span
        className={`presence-dot ${connected ? "presence-dot--online" : "presence-dot--offline"}`}
        title={connected ? "Live updates connected" : "Reconnecting…"}
      />
      {connected ? (
        <span className="presence-count" title={presence.map((p) => p.identity).join(", ")}>
          {activeCount === 0 ? "Only you" : `${activeCount} connected`}
        </span>
      ) : (
        <span className="presence-offline">Reconnecting…</span>
      )}

      {/* Same-file warning */}
      {sameFileWarning && (
        <span className="presence-warning">
          Also editing:{" "}
          <strong>{sameFileWarning.others.join(", ")}</strong>
          <button
            className="presence-warning-dismiss"
            onClick={onDismissWarning}
            title="Dismiss"
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}
