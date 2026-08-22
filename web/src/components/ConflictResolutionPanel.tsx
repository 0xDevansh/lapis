import { useEffect, useState } from "react";
import { Warning, X } from "@phosphor-icons/react";
import type {
  ConflictPayload,
  ConflictResolutionAction,
} from "../api";

export function ConflictBanner({
  count,
  onReview,
}: {
  count: number;
  onReview: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm"
      role="status"
    >
      <Warning size={18} weight="fill" className="shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-ink">
        <strong>{count}</strong> unresolved sync{" "}
        {count === 1 ? "conflict" : "conflicts"}.
      </p>
      <button
        type="button"
        className="shrink-0 rounded border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
        onClick={onReview}
      >
        Review
      </button>
    </div>
  );
}

export default function ConflictResolutionPanel({
  conflict,
  resolving,
  error,
  onClose,
  onResolve,
}: {
  conflict: ConflictPayload;
  resolving: boolean;
  error: string | null;
  onClose: () => void;
  onResolve: (
    action: ConflictResolutionAction,
    content?: string
  ) => Promise<void>;
}) {
  const [merged, setMerged] = useState(
    conflict.clientContent ?? conflict.serverContent ?? ""
  );

  useEffect(() => {
    setMerged(conflict.clientContent ?? conflict.serverContent ?? "");
  }, [conflict.conflictNote]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resolving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, resolving]);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      onMouseDown={() => {
        if (!resolving) onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <Warning
            size={21}
            weight="fill"
            className="mt-0.5 shrink-0 text-danger"
          />
          <div className="min-w-0 flex-1">
            <h2 id="conflict-title" className="font-semibold text-ink">
              Resolve sync conflict
            </h2>
            <p className="truncate font-mono text-xs text-muted">
              {conflict.path} · server r{conflict.serverRevision} · your base r
              {conflict.clientBaseRevision}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={onClose}
            aria-label="Close conflict panel"
            disabled={resolving}
          >
            <X size={18} />
          </button>
        </header>

        <div className="custom-scroll min-h-0 flex-1 overflow-y-auto p-5">
          {conflict.isBinary ? (
            <p className="rounded border border-border bg-secondary p-4 text-sm text-muted">
              This is a binary conflict. The server version is preserved; use
              Keep server here or upload the desired file separately.
            </p>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-3">
                <VersionCard
                  title="Server (current)"
                  content={conflict.serverContent}
                />
                <VersionCard title="Yours" content={conflict.clientContent} />
                <VersionCard
                  title="Common base"
                  content={conflict.baseContent}
                  emptyLabel="Base no longer retained"
                />
              </div>

              <label className="mt-5 block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted">
                  Manual merge
                </span>
                <textarea
                  value={merged}
                  onChange={(event) => setMerged(event.target.value)}
                  className="custom-scroll min-h-48 w-full resize-y rounded border border-border bg-canvas p-3 font-mono text-xs leading-5 text-ink outline-none focus:border-accent"
                  spellCheck={false}
                  disabled={resolving}
                />
              </label>
            </>
          )}
          {error && (
            <p className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
            onClick={() => void onResolve("keep-server")}
            disabled={resolving}
          >
            Keep server
          </button>
          {!conflict.isBinary && (
            <>
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                onClick={() =>
                  void onResolve("keep-client", conflict.clientContent)
                }
                disabled={resolving || conflict.clientContent === undefined}
              >
                Keep yours
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
                onClick={() => void onResolve("use-merged", merged)}
                disabled={resolving}
              >
                Save merged
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function VersionCard({
  title,
  content,
  emptyLabel = "Unavailable",
}: {
  title: string;
  content: string | undefined;
  emptyLabel?: string;
}) {
  return (
    <section className="flex min-h-44 flex-col overflow-hidden rounded border border-border bg-secondary">
      <h3 className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      {content === undefined ? (
        <p className="flex flex-1 items-center justify-center p-3 text-xs italic text-faint">
          {emptyLabel}
        </p>
      ) : (
        <pre className="custom-scroll min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-ink">
          {content}
        </pre>
      )}
    </section>
  );
}
