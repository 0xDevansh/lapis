import { useState, useEffect, useCallback } from "react";
import { listSnapshots, type Snapshot } from "../api";

interface SnapshotsPanelProps {
  vaultId: string;
}

export default function SnapshotsPanel({ vaultId }: SnapshotsPanelProps) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listSnapshots(vaultId);
      setSnapshots(data);
    } catch {
      setError("Failed to load sealed history");
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function formatDate(ts: string): string {
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return ts;
    }
  }

  function shortHash(hash: string): string {
    return hash.slice(0, 7);
  }

  return (
    <div className="snapshots-panel">
      <button
        className="snapshots-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Sealed History
      </button>

      {open && (
        <div className="snapshots-list">
          {loading && <div className="snapshots-empty">Loading...</div>}
          {error && <div className="snapshots-empty snapshots-error">{error}</div>}
          {!loading && !error && snapshots.length === 0 && (
            <div className="snapshots-empty">
              No sealed commits yet. Commits are created automatically after writes.
            </div>
          )}
          {!loading && !error && snapshots.map(s => (
            <div key={s.hash} className="snapshot-entry">
              <span className="snapshot-hash">{shortHash(s.hash)}</span>
              <span className="snapshot-message">{s.message}</span>
              <span className="snapshot-ts">{formatDate(s.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
