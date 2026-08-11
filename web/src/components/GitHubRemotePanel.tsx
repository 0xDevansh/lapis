import { useCallback, useEffect, useState } from "react";
import {
  GithubLogo,
  ArrowsClockwise,
  Plugs,
  PlugsConnected,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react";
import * as api from "../api";
import { useToast } from "./ui/Toast";

interface GitHubRemotePanelProps {
  vaultId: string;
  /** Start expanded (e.g. inside the settings popover). */
  defaultOpen?: boolean;
}

const SYNC_LABELS: Record<api.GitRemoteSyncState, string> = {
  idle: "Up to date",
  pulling: "Pulling from GitHub…",
  pushing: "Pushing to GitHub…",
  conflict: "Sync conflict",
};

const SYNC_TONE: Record<api.GitRemoteSyncState, string> = {
  idle: "text-success border-success/30 bg-success/10",
  pulling: "text-accent-soft border-accent/30 bg-accent/10",
  pushing: "text-accent-soft border-accent/30 bg-accent/10",
  conflict: "text-danger border-danger/30 bg-danger/10",
};

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.slice(0, 7);
}

export default function GitHubRemotePanel({
  vaultId,
  defaultOpen = false,
}: GitHubRemotePanelProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [status, setStatus] = useState<api.GitRemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [subdir, setSubdir] = useState("");
  const [pat, setPat] = useState("");

  const reload = useCallback(async () => {
    try {
      const s = await api.getGitRemote(vaultId);
      setStatus(s);
      if (s.connected && s.repoUrl) {
        setRepoUrl(s.repoUrl);
        setBranch(s.branch ?? "main");
        setSubdir(s.subdir ?? "");
      }
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [vaultId, toast]);

  // Load status once for the collapsed summary; poll only while expanded.
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => void reload(), 8000);
    return () => clearInterval(interval);
  }, [open, reload]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!repoUrl.trim() || !pat.trim()) {
      toast("Repository URL and personal access token are required", { tone: "error" });
      return;
    }
    setBusy("connect");
    try {
      await api.connectGitRemote(vaultId, {
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || "main",
        subdir: subdir.trim() || undefined,
        pat: pat.trim(),
      });
      setPat("");
      setEditing(false);
      await reload();
      toast("GitHub repository connected", { tone: "success" });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect GitHub sync? The vault will stop syncing to this repository.")) return;
    setBusy("disconnect");
    try {
      await api.disconnectGitRemote(vaultId);
      setRepoUrl("");
      setBranch("main");
      setSubdir("");
      setPat("");
      setEditing(false);
      await reload();
      toast("GitHub repository disconnected", { tone: "success" });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleSyncNow() {
    setBusy("sync");
    try {
      const result = await api.pushGitRemote(vaultId);
      await reload();
      if (result.fileCount === 0) {
        toast("Already in sync — no new changes to push", { tone: "success" });
      } else {
        toast(
          `Synced ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to GitHub`,
          { tone: "success" }
        );
      }
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const connected = status?.connected === true;
  const syncState = status?.syncState ?? "idle";
  const showForm = !connected || editing;

  const inputClass =
    "w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent/50";
  const labelClass = "mb-1 block text-xs font-semibold uppercase tracking-wide text-muted";

  return (
    <section className="mb-10 rounded-lg border border-border bg-surface/50 px-4 py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? (
          <CaretDown size={16} className="mt-1.5 shrink-0 text-muted" />
        ) : (
          <CaretRight size={16} className="mt-1.5 shrink-0 text-muted" />
        )}
        <GithubLogo size={22} weight="duotone" className="mt-0.5 shrink-0 text-ink" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">GitHub Sync</h2>
            {!loading && connected && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SYNC_TONE[syncState]}`}
              >
                {SYNC_LABELS[syncState]}
              </span>
            )}
            {!loading && !connected && (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-muted">
                Not connected
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {open
              ? "Mirror this vault to a GitHub repository. Changes sync bidirectionally on save."
              : connected
                ? status?.repoUrl ?? "Connected"
                : "Mirror this vault to a GitHub repository."}
          </p>
        </div>
      </button>

      {!open ? null : (
        <div className="mt-3">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : connected && !editing ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-canvas px-3 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <PlugsConnected size={16} className="text-success" />
                  <span className="text-sm font-medium text-ink">Connected</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SYNC_TONE[syncState]}`}
                  >
                    {SYNC_LABELS[syncState]}
                  </span>
                </div>
                <dl className="grid gap-1.5 text-sm">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">Repository</dt>
                    <dd>
                      <a
                        href={status.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-accent-soft hover:underline"
                      >
                        {status.repoUrl}
                      </a>
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">Branch</dt>
                    <dd className="font-mono">{status.branch}</dd>
                  </div>
                  {status.subdir && (
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="text-muted">Subdirectory</dt>
                      <dd className="font-mono">{status.subdir}</dd>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">Token</dt>
                    <dd className="font-mono">••••{status.patLast4 ?? "????"}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">Last sync</dt>
                    <dd>{formatDateTime(status.lastSyncedAt)}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">Commit</dt>
                    <dd className="font-mono">{shortHash(status.lastSyncedCommit)}</dd>
                  </div>
                </dl>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleSyncNow()}
                  disabled={busy !== null || syncState === "pulling" || syncState === "pushing"}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowsClockwise size={16} className={busy === "sync" ? "animate-spin" : ""} />
                  Sync now
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                  className="rounded-md border border-border px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-accent/40 disabled:opacity-50"
                >
                  Update settings
                </button>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={busy !== null}
                  className="rounded-md border border-border px-3 py-2 text-sm font-medium text-danger transition-colors hover:border-danger/50 disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : null}

          {showForm && (
            <form onSubmit={(e) => void handleConnect(e)} className="space-y-3">
              {!connected && (
                <p className="text-sm text-muted">
                  Create a GitHub repo and a personal access token with{" "}
                  <strong className="text-ink">Contents</strong> read/write scope.
                </p>
              )}
              <div>
                <label className={labelClass} htmlFor="github-repo-url">
                  Repository URL
                </label>
                <input
                  id="github-repo-url"
                  type="url"
                  required
                  placeholder="https://github.com/you/your-repo"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="github-branch">
                    Branch
                  </label>
                  <input
                    id="github-branch"
                    type="text"
                    placeholder="main"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="github-subdir">
                    Subdirectory{" "}
                    <span className="font-normal normal-case text-faint">(optional)</span>
                  </label>
                  <input
                    id="github-subdir"
                    type="text"
                    placeholder="notes"
                    value={subdir}
                    onChange={(e) => setSubdir(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="github-pat">
                  Personal access token
                </label>
                <input
                  id="github-pat"
                  type="password"
                  required
                  autoComplete="off"
                  placeholder={connected ? "Enter a new token to update" : "ghp_…"}
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-faint">
                  Stored encrypted on the server. Only the last four characters are shown after saving.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  disabled={busy === "connect"}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:bg-accent-soft disabled:opacity-50"
                >
                  {connected ? <PlugsConnected size={16} /> : <Plugs size={16} />}
                  {connected ? "Save changes" : "Connect repository"}
                </button>
                {editing && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setPat("");
                      if (status?.connected) {
                        setRepoUrl(status.repoUrl ?? "");
                        setBranch(status.branch ?? "main");
                        setSubdir(status.subdir ?? "");
                      }
                    }}
                    disabled={busy === "connect"}
                    className="rounded-md border border-border px-3 py-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
