import { useState, useEffect, useCallback } from "react";
import { CaretRight, ClockCounterClockwise } from "@phosphor-icons/react";
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
    <div className="border-t border-border">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted transition-colors hover:text-ink"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <CaretRight
          size={12}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <ClockCounterClockwise size={22} />
        Version Control
      </button>

      {open && (
        <div className="max-h-56 overflow-y-auto px-2 pb-2 custom-scroll">
          {loading && <div className="px-2 py-1.5 text-xs text-muted">Loading…</div>}
          {error && <div className="px-2 py-1.5 text-xs text-danger">{error}</div>}
          {!loading && !error && snapshots.length === 0 && (
            <div className="px-2 py-1.5 text-xs leading-relaxed text-faint">
              No GitHub commits yet. Connect a GitHub remote under Settings → GitHub to enable history.
            </div>
          )}
          {!loading &&
            !error &&
            snapshots.map((s) => (
              <div
                key={s.hash}
                className="flex flex-col gap-0.5 rounded px-2 py-1.5 hover:bg-hover"
                title={s.hash}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-accent-soft">
                    {shortHash(s.hash)}
                  </span>
                  <span className="shrink-0 text-[10px] text-faint">
                    {formatDate(s.ts)}
                  </span>
                </div>
                <span className="truncate text-[12px] text-ink">{s.message}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
