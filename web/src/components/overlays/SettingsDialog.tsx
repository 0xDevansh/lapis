import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  DeviceMobile,
  DownloadSimple,
  GithubLogo,
  Key,
  Moon,
  Plugs,
  ShieldCheck,
  Sun,
  UsersThree,
  Vault,
  Warning,
  X,
} from "@phosphor-icons/react";
import * as api from "../../api";
import type { Theme } from "../../hooks/useTheme";
import GitHubRemotePanel from "../GitHubRemotePanel";
import { useToast } from "../ui/Toast";

type SettingsTab = "vault" | "members" | "mcp" | "devices" | "github" | "export" | "appearance";

interface SettingsDialogProps {
  vaultId: string;
  vaultName: string;
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  exportUrl: string;
  vaultRole?: api.VaultRole;
  onVaultRenamed?: (vault: api.Vault) => void;
  onVaultArchived?: () => void;
  onNavigateGuard: () => boolean;
}

interface TabConfig {
  id: SettingsTab;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export default function SettingsDialog({
  vaultId,
  vaultName,
  open,
  onClose,
  theme,
  onToggleTheme,
  exportUrl,
  vaultRole,
  onVaultRenamed,
  onVaultArchived,
  onNavigateGuard,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("vault");
  const [dirty, setDirty] = useState(false);
  const [resolvedRole, setResolvedRole] = useState<api.VaultRole | undefined>(vaultRole);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (vaultRole) setResolvedRole(vaultRole);
  }, [vaultRole]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.getVault(vaultId).then((vault) => {
      if (!cancelled && vault.role) setResolvedRole(vault.role);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, vaultId]);

  function requestClose() {
    if (
      dirty &&
      !confirm("You have unsaved settings. Close without saving?")
    ) {
      return;
    }
    setDirty(false);
    onClose();
  }

  const tabs: TabConfig[] = useMemo(() => {
    const all: TabConfig[] = [
      {
        id: "vault",
        label: "Vault",
        description: "Name, archive, and restore settings.",
        icon: <Vault size={18} weight="duotone" />,
      },
      {
        id: "members",
        label: "Members",
        description: "Invite editors and viewers to this vault.",
        icon: <UsersThree size={18} weight="duotone" />,
      },
      {
        id: "mcp",
        label: "MCP",
        description: "Expose this vault to coding agents.",
        icon: <Plugs size={18} weight="duotone" />,
      },
      {
        id: "devices",
        label: "Devices",
        description: "Approve and revoke Obsidian devices.",
        icon: <DeviceMobile size={18} weight="duotone" />,
      },
      {
        id: "github",
        label: "GitHub",
        description: "Mirror this vault to a repository.",
        icon: <GithubLogo size={18} weight="duotone" />,
      },
      {
        id: "export",
        label: "Export",
        description: "Download a vault backup.",
        icon: <DownloadSimple size={18} />,
      },
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme and display preferences.",
        icon: theme === "dark" ? <Sun size={18} /> : <Moon size={18} />,
      },
    ];
    return all.filter((item) => {
      if (item.id === "vault" || item.id === "mcp" || item.id === "github") {
        return resolvedRole !== "editor" && resolvedRole !== "viewer";
      }
      return true;
    });
  }, [theme, resolvedRole]);

  useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) {
      setTab(tabs[0]?.id ?? "appearance");
    }
  }, [tabs, tab]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) {
      previouslyFocusedRef.current?.focus();
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dirty, onClose]);

  if (!open) return null;

  const active = tabs.find((item) => item.id === tab) ?? tabs[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-3 backdrop-blur-[1px] sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-[min(720px,calc(100vh-2rem))] w-[min(920px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)] max-sm:flex-col"
      >
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-secondary/80 max-sm:w-full max-sm:border-b max-sm:border-r-0">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 id="settings-title" className="text-base font-bold text-ink">
                Settings
              </h2>
              <p className="mt-0.5 max-w-40 truncate text-[12px] text-muted" title={vaultName}>
                {vaultName}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close settings"
              onClick={requestClose}
              className="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <nav
            aria-label="Settings sections"
            className="custom-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2 max-sm:flex-row max-sm:overflow-x-auto"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={[
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors max-sm:shrink-0",
                  item.id === tab
                    ? "bg-surface text-ink shadow-sm"
                    : "text-muted hover:bg-hover hover:text-ink",
                ].join(" ")}
              >
                <span className={item.id === tab ? "text-accent-soft" : "text-faint"}>
                  {item.icon}
                </span>
                <span className="font-medium">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="custom-scroll min-h-0 flex-1 overflow-y-auto bg-canvas">
          <div className="border-b border-border bg-elevated px-6 py-4 max-sm:px-4">
            <div className="flex items-center gap-2">
              <span className="text-accent-soft">{active.icon}</span>
              <h3 className="text-lg font-bold text-ink">{active.label}</h3>
            </div>
            <p className="mt-1 text-sm text-muted">{active.description}</p>
          </div>

          <div className="p-6 max-sm:p-4">
            {tab === "vault" && (
              <VaultSettings
                vaultId={vaultId}
                vaultName={vaultName}
                onRenamed={onVaultRenamed}
                onArchived={onVaultArchived}
                onClose={onClose}
                onDirtyChange={setDirty}
                onNavigateGuard={onNavigateGuard}
                toast={toast}
              />
            )}
            {tab === "members" && (
              <MembersSettings vaultId={vaultId} role={resolvedRole ?? "owner"} toast={toast} />
            )}
            {tab === "mcp" && (
              <McpSettings vaultId={vaultId} toast={toast} onDirtyChange={setDirty} />
            )}
            {tab === "devices" && <DevicesSettings vaultId={vaultId} toast={toast} />}
            {tab === "github" && <GitHubRemotePanel vaultId={vaultId} defaultOpen />}
            {tab === "export" && <ExportSettings exportUrl={exportUrl} />}
            {tab === "appearance" && (
              <AppearanceSettings theme={theme} onToggleTheme={onToggleTheme} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function VaultSettings({
  vaultId,
  vaultName,
  onRenamed,
  onArchived,
  onClose,
  onDirtyChange,
  onNavigateGuard,
  toast,
}: {
  vaultId: string;
  vaultName: string;
  onRenamed?: (vault: api.Vault) => void;
  onArchived?: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onNavigateGuard: () => boolean;
  toast: (msg: string, opts?: { tone?: "success" | "error" | "info"; duration?: number }) => void;
}) {
  const [name, setName] = useState(vaultName);
  const [busy, setBusy] = useState<"rename" | "archive" | null>(null);

  useEffect(() => setName(vaultName), [vaultName]);
  useEffect(() => {
    onDirtyChange(name.trim() !== vaultName && name.trim().length > 0);
    return () => onDirtyChange(false);
  }, [name, vaultName, onDirtyChange]);

  async function handleRename(event: React.FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === vaultName) return;
    setBusy("rename");
    try {
      const vault = await api.renameVault(vaultId, next);
      onRenamed?.(vault);
      toast("Vault renamed", { tone: "success" });
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive() {
    if (!onNavigateGuard()) return;
    if (
      !confirm(
        "Archive this vault? It will disappear from the active list and sync/MCP access will pause until you restore it."
      )
    ) {
      return;
    }
    setBusy("archive");
    try {
      await api.archiveVault(vaultId);
      toast("Vault archived", { tone: "success" });
      onArchived?.();
      onClose();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleRename} className="rounded-lg border border-border bg-surface/60 p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Vault name
        </label>
        <div className="flex gap-2 max-sm:flex-col">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
            maxLength={120}
          />
          <button
            type="submit"
            disabled={busy !== null || !name.trim() || name.trim() === vaultName}
            className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent transition-opacity disabled:opacity-50"
          >
            {busy === "rename" ? "Saving..." : "Rename"}
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-danger/30 bg-danger/5 p-4">
        <div className="flex items-start gap-3">
          <Archive size={20} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-ink">Archive vault</h4>
            <p className="mt-1 text-sm text-muted">
              Archived vaults are preserved and can be restored later, but web workspace,
              plugin sync, GitHub pushes, and MCP access are paused.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void handleArchive()}
              className="mt-3 rounded-md border border-danger/50 px-3 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              {busy === "archive" ? "Archiving..." : "Archive vault"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function McpSettings({
  vaultId,
  toast,
  onDirtyChange,
}: {
  vaultId: string;
  toast: (msg: string, opts?: { tone?: "success" | "error" | "info"; duration?: number }) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [policy, setPolicy] = useState<api.McpVaultPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pathAllow, setPathAllow] = useState("");
  const [pathDeny, setPathDeny] = useState("");
  const [maxReadBytes, setMaxReadBytes] = useState("131072");
  const [maxWriteBytes, setMaxWriteBytes] = useState("131072");
  const [maxResults, setMaxResults] = useState("100");
  const [tokens, setTokens] = useState<api.McpToken[] | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<api.CreatedMcpToken | null>(null);
  const [tokenBusy, setTokenBusy] = useState<string | null>(null);
  const endpoint = `${window.location.origin}/api/mcp`;

  useEffect(() => {
    let alive = true;
    api
      .getMcpPolicy(vaultId)
      .then((next) => {
        if (!alive) return;
        setPolicy(next);
        setPathAllow(next.pathAllow.join("\n"));
        setPathDeny(next.pathDeny.join("\n"));
        setMaxReadBytes(String(next.maxReadBytes));
        setMaxWriteBytes(String(next.maxWriteBytes));
        setMaxResults(String(next.maxResults));
      })
      .catch((error) => toast((error as Error).message, { tone: "error" }))
      .finally(() => {
        if (alive) setLoading(false);
      });
    api
      .listMcpTokens()
      .then((next) => {
        if (alive) setTokens(next);
      })
      .catch((error) => toast((error as Error).message, { tone: "error" }));
    return () => {
      alive = false;
    };
  }, [vaultId, toast]);

  const parsedAllow = pathAllow.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsedDeny = pathDeny.split("\n").map((line) => line.trim()).filter(Boolean);
  const limitsDirty =
    policy != null &&
    (parsedAllow.join("\n") !== policy.pathAllow.join("\n") ||
      parsedDeny.join("\n") !== policy.pathDeny.join("\n") ||
      Number(maxReadBytes) !== policy.maxReadBytes ||
      Number(maxWriteBytes) !== policy.maxWriteBytes ||
      Number(maxResults) !== policy.maxResults);

  useEffect(() => {
    onDirtyChange(limitsDirty);
    return () => onDirtyChange(false);
  }, [limitsDirty, onDirtyChange]);

  async function save(updates: Partial<api.McpVaultPolicy>) {
    if (!policy) return;
    const optimistic = { ...policy, ...updates };
    setPolicy(optimistic);
    setSaving(true);
    try {
      setPolicy(await api.updateMcpPolicy(vaultId, updates));
      toast("MCP settings saved", { tone: "success" });
    } catch (error) {
      setPolicy(policy);
      toast((error as Error).message, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, { tone: "success" });
    } catch {
      toast("Could not copy to clipboard", { tone: "error" });
    }
  }

  if (loading || !policy) {
    return <p className="text-sm text-muted">Loading MCP settings...</p>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-ink">Vault visibility</h4>
            <p className="mt-1 text-sm text-muted">
              Enable this vault for MCP clients that connect with a personal token.
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save({ enabled: !policy.enabled })}
            className={[
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              policy.enabled
                ? "bg-success text-on-success"
                : "border border-border text-muted hover:bg-hover",
            ].join(" ")}
          >
            {policy.enabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <PolicyToggle
            label="Read/write mode"
            description="Allow write, edit, patch, move, and folder marker operations."
            checked={policy.mode === "read-write"}
            disabled={!policy.enabled || saving}
            onChange={(checked) => void save({ mode: checked ? "read-write" : "read-only" })}
          />
          <PolicyToggle
            label="grep"
            description="Allow content searches with regex or literal patterns."
            checked={policy.allowGrep}
            disabled={!policy.enabled || saving}
            onChange={(checked) => void save({ allowGrep: checked })}
          />
          <PolicyToggle
            label="delete"
            description="Allow rm. Kept off by default for agent safety."
            checked={policy.allowDelete}
            disabled={!policy.enabled || saving || policy.mode !== "read-write"}
            onChange={(checked) => void save({ allowDelete: checked })}
          />
          <PolicyToggle
            label="internals"
            description="Allow access to vault internals such as .obsidian."
            checked={policy.allowInternals}
            disabled={!policy.enabled || saving}
            onChange={(checked) => void save({ allowInternals: checked })}
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface/60 p-4">
        <h4 className="text-sm font-semibold text-ink">Path rules and limits</h4>
        <p className="mt-1 text-sm text-muted">
          One glob per line. Allow list is optional; deny always wins. Limits
          cap what agents can read, write, or return from grep/find/ls.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
              Allow
            </span>
            <textarea
              value={pathAllow}
              onChange={(event) => setPathAllow(event.target.value)}
              disabled={!policy.enabled || saving}
              rows={4}
              placeholder={"notes/**\njournal/*.md"}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
              Deny
            </span>
            <textarea
              value={pathDeny}
              onChange={(event) => setPathDeny(event.target.value)}
              disabled={!policy.enabled || saving}
              rows={4}
              placeholder={"private/**\n*.pem"}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </label>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
              Max read bytes
            </span>
            <input
              type="number"
              min={1024}
              max={1048576}
              value={maxReadBytes}
              onChange={(event) => setMaxReadBytes(event.target.value)}
              disabled={!policy.enabled || saving}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
              Max write bytes
            </span>
            <input
              type="number"
              min={1024}
              max={1048576}
              value={maxWriteBytes}
              onChange={(event) => setMaxWriteBytes(event.target.value)}
              disabled={!policy.enabled || saving}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
              Max results
            </span>
            <input
              type="number"
              min={1}
              max={1000}
              value={maxResults}
              onChange={(event) => setMaxResults(event.target.value)}
              disabled={!policy.enabled || saving}
              className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={!policy.enabled || saving || !limitsDirty}
          onClick={() =>
            void save({
              pathAllow: parsedAllow,
              pathDeny: parsedDeny,
              maxReadBytes: Number(maxReadBytes),
              maxWriteBytes: Number(maxWriteBytes),
              maxResults: Number(maxResults),
            })
          }
          className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save path rules"}
        </button>
      </section>

      <section className="rounded-lg border border-border bg-surface/60 p-4">
        <h4 className="text-sm font-semibold text-ink">Connection endpoint</h4>
        <p className="mt-1 text-sm text-muted">
          Streamable HTTP endpoint. Clients send{" "}
          <code className="text-ink">Authorization: Bearer lapis_…</code> on every request.
        </p>
        <div className="mt-3 flex gap-2 rounded-md border border-border bg-canvas p-2">
          <code className="min-w-0 flex-1 truncate text-xs text-ink">{endpoint}</code>
          <button
            type="button"
            onClick={() => void copy(endpoint, "Endpoint")}
            className="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
            aria-label="Copy MCP endpoint"
          >
            <Copy size={16} />
          </button>
        </div>
      </section>

      <McpTokenSettings
        tokens={tokens}
        tokenName={tokenName}
        createdToken={createdToken}
        busy={tokenBusy}
        onNameChange={setTokenName}
        onCreate={async () => {
          setTokenBusy("create");
          try {
            const created = await api.createMcpToken(tokenName);
            setCreatedToken(created);
            setTokenName("");
            setTokens(await api.listMcpTokens());
            toast("Token created. Copy it now — it will not be shown again.", {
              tone: "success",
            });
          } catch (error) {
            toast((error as Error).message, { tone: "error" });
          } finally {
            setTokenBusy(null);
          }
        }}
        onRevoke={async (id) => {
          if (!confirm("Revoke this MCP token? Clients using it will lose access immediately.")) {
            return;
          }
          setTokenBusy(id);
          try {
            await api.revokeMcpToken(id);
            if (createdToken?.id === id) setCreatedToken(null);
            setTokens(await api.listMcpTokens());
            toast("Token revoked", { tone: "success" });
          } catch (error) {
            toast((error as Error).message, { tone: "error" });
          } finally {
            setTokenBusy(null);
          }
        }}
        onCopy={copy}
      />

      <ClientSetupTabs
        endpoint={endpoint}
        tokenValue={createdToken?.token ?? "lapis_YOUR_TOKEN"}
        onCopy={copy}
      />
    </div>
  );
}

function McpTokenSettings({
  tokens,
  tokenName,
  createdToken,
  busy,
  onNameChange,
  onCreate,
  onRevoke,
  onCopy,
}: {
  tokens: api.McpToken[] | null;
  tokenName: string;
  createdToken: api.CreatedMcpToken | null;
  busy: string | null;
  onNameChange: (value: string) => void;
  onCreate: () => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onCopy: (text: string, label: string) => Promise<void>;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface/60 p-4">
      <div className="flex items-start gap-3">
        <Key size={20} className="mt-0.5 shrink-0 text-accent-soft" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-ink">Personal tokens</h4>
          <p className="mt-1 text-sm text-muted">
            Account-wide tokens for Cursor, Claude Code, and other MCP clients.
            Create one below, then paste it into the client config. The secret
            is shown once.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate();
        }}
      >
        <input
          value={tokenName}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="ssh box, CI, laptop…"
          maxLength={64}
          disabled={busy !== null}
          className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent transition-opacity disabled:opacity-50"
        >
          {busy === "create" ? "Creating..." : "Create token"}
        </button>
      </form>

      {createdToken && (
        <div className="mt-3 rounded-md border border-accent/40 bg-canvas p-3">
          <div className="flex items-start gap-2">
            <Warning size={16} className="mt-0.5 shrink-0 text-accent-soft" />
            <p className="text-sm text-muted">
              Copy <span className="font-semibold text-ink">{createdToken.name}</span> now.
              Lapis stores only a hash after this.
            </p>
          </div>
          <CodeWithCopy code={createdToken.token} label="MCP token" onCopy={onCopy} />
        </div>
      )}

      <div className="mt-4">
        {!tokens ? (
          <p className="text-[13px] text-muted">Loading tokens...</p>
        ) : tokens.length === 0 ? (
          <p className="text-[13px] text-muted">No tokens yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-[13px]"
              >
                <Key size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {token.name}
                  <span className="ml-2 font-mono text-faint">…{token.last4}</span>
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  className="text-[12px] text-danger hover:underline disabled:opacity-50"
                  onClick={() => void onRevoke(token.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PolicyToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-canvas p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
      </span>
    </label>
  );
}

function ClientSetupTabs({
  endpoint,
  tokenValue,
  onCopy,
}: {
  endpoint: string;
  tokenValue: string;
  onCopy: (text: string, label: string) => Promise<void>;
}) {
  type Client = "cursor" | "claude-code" | "claude" | "vscode" | "opencode" | "generic";
  const [client, setClient] = useState<Client>("cursor");
  const tokenHeaders = { Authorization: `Bearer ${tokenValue}` };
  const cursorJson = JSON.stringify(
    { mcpServers: { lapis: { url: endpoint, headers: tokenHeaders } } },
    null,
    2
  );
  const vscodeJson = JSON.stringify(
    { servers: { lapis: { url: endpoint, type: "http", headers: tokenHeaders } } },
    null,
    2
  );
  const opencodeJson = JSON.stringify(
    { mcp: { lapis: { type: "remote", url: endpoint, headers: tokenHeaders } } },
    null,
    2
  );
  const claudeCommand = `claude mcp add --transport http lapis ${endpoint} --header "Authorization: Bearer ${tokenValue}"`;

  const tabs: Array<{ id: Client; label: string }> = [
    { id: "cursor", label: "Cursor" },
    { id: "claude-code", label: "Claude Code" },
    { id: "claude", label: "Claude" },
    { id: "vscode", label: "VS Code" },
    { id: "opencode", label: "OpenCode" },
    { id: "generic", label: "Generic" },
  ];

  return (
    <section className="rounded-lg border border-border bg-surface/60 p-4">
      <h4 className="text-sm font-semibold text-ink">Client setup</h4>
      <p className="mt-1 text-sm text-muted">
        Create a personal token above, then paste the config. Replace{" "}
        <code className="text-ink">lapis_YOUR_TOKEN</code> if you have not just created one.
      </p>
      <div className="custom-scroll mt-3 flex gap-1 overflow-x-auto rounded-lg bg-canvas p-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setClient(item.id)}
            className={[
              "shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
              client === item.id ? "bg-elevated text-ink shadow-sm" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3 text-sm text-muted">
        {client === "cursor" && (
          <SetupBlock
            title="Cursor"
            body="Paste this into .cursor/mcp.json in the project, or ~/.cursor/mcp.json for all projects."
            code={cursorJson}
            copyLabel="Cursor JSON"
            onCopy={onCopy}
          />
        )}
        {client === "claude-code" && (
          <SetupBlock
            title="Claude Code"
            body="Add the remote HTTP server with the personal token as an Authorization header."
            code={claudeCommand}
            copyLabel="Claude command"
            onCopy={onCopy}
          />
        )}
        {client === "claude" && (
          <div className="rounded-md border border-border bg-canvas p-3">
            <p>
              Claude Desktop custom connectors still prefer OAuth. For Claude Code,
              use the token command in the Claude Code tab.
            </p>
            <CodeWithCopy code={endpoint} label="Endpoint" onCopy={onCopy} />
          </div>
        )}
        {client === "vscode" && (
          <SetupBlock
            title="VS Code"
            body="Add this to your MCP servers JSON. VS Code uses servers instead of mcpServers."
            code={vscodeJson}
            copyLabel="VS Code JSON"
            onCopy={onCopy}
          />
        )}
        {client === "opencode" && (
          <SetupBlock
            title="OpenCode"
            body="Add the remote server with an Authorization header. No browser login is required."
            code={opencodeJson}
            copyLabel="OpenCode JSON"
            onCopy={onCopy}
          />
        )}
        {client === "generic" && (
          <div className="rounded-md border border-border bg-canvas p-3">
            <p>
              Send Authorization: Bearer lapis_… on every Streamable HTTP request.
              Invalid or revoked tokens return 401.
            </p>
            <CodeWithCopy code={cursorJson} label="MCP JSON" onCopy={onCopy} />
          </div>
        )}
      </div>
    </section>
  );
}

function SetupBlock({
  title,
  body,
  code,
  copyLabel,
  onCopy,
  link,
  linkLabel,
}: {
  title: string;
  body: string;
  code: string;
  copyLabel: string;
  onCopy: (text: string, label: string) => Promise<void>;
  link?: string;
  linkLabel?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h5 className="text-sm font-semibold text-ink">{title}</h5>
          <p className="mt-1 text-sm text-muted">{body}</p>
        </div>
        {link && linkLabel && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            {linkLabel}
          </a>
        )}
      </div>
      <CodeWithCopy code={code} label={copyLabel} onCopy={onCopy} />
    </div>
  );
}

function CodeWithCopy({
  code,
  label,
  onCopy,
}: {
  code: string;
  label: string;
  onCopy: (text: string, label: string) => Promise<void>;
}) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-elevated p-2">
      <pre className="custom-scroll min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-ink">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => void onCopy(code, label)}
        className="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
        aria-label={`Copy ${label}`}
      >
        <Copy size={16} />
      </button>
    </div>
  );
}

function ExportSettings({ exportUrl }: { exportUrl: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-4">
      <DownloadSimple size={24} className="mb-2 text-accent-soft" />
      <p className="mb-4 text-sm text-muted">
        Download a zip of every non-internal file in this vault.
      </p>
      <a
        href={exportUrl}
        download
        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:opacity-90"
      >
        <DownloadSimple size={16} /> Download vault
      </a>
    </div>
  );
}

function AppearanceSettings({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-4">
      <p className="mb-4 text-sm text-muted">Switch between light and dark themes.</p>
      <button
        type="button"
        onClick={onToggleTheme}
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-hover"
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        Use {theme === "dark" ? "light" : "dark"} theme
      </button>
    </div>
  );
}

function DevicesSettings({
  vaultId,
  toast,
}: {
  vaultId: string;
  toast: (msg: string, opts?: { tone?: "success" | "error" | "info"; duration?: number }) => void;
}) {
  const [pending, setPending] = useState<api.PendingDevice[] | null>(null);
  const [devices, setDevices] = useState<api.Device[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async () => {
    const [p, d] = await Promise.all([
      api.getPendingDevices(vaultId),
      api.listDevices(vaultId),
    ]);
    setPending(p);
    setDevices(d);
  };

  useEffect(() => {
    void reload().catch((e) => toast((e as Error).message, { tone: "error" }));
    const id = setInterval(() => void reload().catch(() => {}), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  async function copyVaultLink() {
    const link = `${window.location.origin}/vault/${vaultId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Vault link copied", { tone: "success" });
    } catch {
      toast("Could not copy link", { tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-surface/60 p-4">
        <p className="mb-3 text-sm text-muted">
          Paste the vault link in Obsidian, then approve the code below.
        </p>
        <button
          type="button"
          onClick={() => void copyVaultLink()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-hover"
        >
          <Copy size={14} /> Copy vault link
        </button>
      </div>

      <div className="rounded-lg border border-border bg-surface/60 p-4">
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">
          Pending
        </h4>
        {!pending ? (
          <p className="text-[13px] text-muted">Loading...</p>
        ) : pending.length === 0 ? (
          <p className="text-[13px] text-muted">No pending requests.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.userCode}
                className="flex items-center gap-2 rounded-md border border-border bg-canvas px-2.5 py-2"
              >
                <span className="font-mono text-sm font-semibold tracking-wider text-accent-soft">
                  {p.userCode}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  {p.deviceName}
                </span>
                <button
                  type="button"
                  disabled={busy === p.userCode}
                  className="rounded bg-success p-1 text-on-success disabled:opacity-50"
                  title="Approve"
                  onClick={async () => {
                    setBusy(p.userCode);
                    try {
                      await api.approveDevice(vaultId, p.userCode);
                      await reload();
                    } catch (e) {
                      toast((e as Error).message, { tone: "error" });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <Check size={14} weight="bold" />
                </button>
                <button
                  type="button"
                  disabled={busy === p.userCode}
                  className="rounded border border-border p-1 text-danger disabled:opacity-50"
                  title="Deny"
                  onClick={async () => {
                    setBusy(p.userCode);
                    try {
                      await api.denyDevice(vaultId, p.userCode);
                      await reload();
                    } catch (e) {
                      toast((e as Error).message, { tone: "error" });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <X size={14} weight="bold" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface/60 p-4">
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">
          Connected
        </h4>
        {!devices ? (
          <p className="text-[13px] text-muted">Loading...</p>
        ) : devices.length === 0 ? (
          <p className="text-[13px] text-muted">No devices yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-[13px]"
              >
                <DeviceMobile size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-ink">{d.deviceName}</span>
                <button
                  type="button"
                  disabled={busy === d.id}
                  className="text-[12px] text-danger hover:underline disabled:opacity-50"
                  onClick={async () => {
                    if (!confirm(`Revoke ${d.deviceName}?`)) return;
                    setBusy(d.id);
                    try {
                      await api.revokeDevice(vaultId, d.id);
                      await reload();
                    } catch (e) {
                      toast((e as Error).message, { tone: "error" });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface/60 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent-soft" />
          <p className="text-sm text-muted">
            Devices use revocable sync tokens scoped to this vault. MCP clients use
            a separate account-wide personal token under the MCP section.
          </p>
        </div>
      </div>
    </div>
  );
}

function MembersSettings({
  vaultId,
  role,
  toast,
}: {
  vaultId: string;
  role: api.VaultRole;
  toast: (msg: string, opts?: { tone?: "success" | "error" | "info"; duration?: number }) => void;
}) {
  const isOwner = role === "owner";
  const [members, setMembers] = useState<api.VaultMember[]>([]);
  const [invites, setInvites] = useState<api.VaultInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [nextMembers, nextInvites] = await Promise.all([
      api.listVaultMembers(vaultId),
      api.listVaultInvites(vaultId),
    ]);
    setMembers(nextMembers);
    setInvites(nextInvites);
  };

  useEffect(() => {
    refresh()
      .catch((error) => toast((error as Error).message, { tone: "error" }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    const nextEmail = email.trim();
    if (!nextEmail) return;
    setBusy(true);
    try {
      await api.inviteVaultMember(vaultId, nextEmail, inviteRole);
      setEmail("");
      await refresh();
      toast("Invite sent", { tone: "success" });
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(userId: string, nextRole: "editor" | "viewer") {
    try {
      await api.updateVaultMemberRole(vaultId, userId, nextRole);
      await refresh();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm("Remove this member from the vault?")) return;
    try {
      await api.removeVaultMember(vaultId, userId);
      await refresh();
      toast("Member removed", { tone: "success" });
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  }

  async function handleCancel(inviteId: string) {
    try {
      await api.cancelVaultInvite(vaultId, inviteId);
      await refresh();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  }

  const canInvite = role === "owner" || role === "editor";

  if (loading) return <p className="text-sm text-muted">Loading members…</p>;

  return (
    <div className="space-y-6">
      {canInvite && (
      <form onSubmit={handleInvite} className="rounded-lg border border-border bg-surface/60 p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Invite by email
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}
            className="rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-soft disabled:opacity-50"
          >
            {busy ? "Inviting…" : "Invite"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Invites appear on their vault list when they sign in with this email.
        </p>
      </form>
      )}

      <div className="rounded-lg border border-border bg-surface/60 p-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Members</h4>
        <ul className="flex list-none flex-col gap-2 p-0">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">
                  {member.name || member.email}
                </span>
                <span className="text-xs text-muted">{member.email}</span>
              </span>
              {member.role === "owner" || !isOwner ? (
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {member.role}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <select
                    value={member.role}
                    onChange={(event) =>
                      void handleRoleChange(
                        member.userId,
                        event.target.value as "editor" | "viewer"
                      )
                    }
                    className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink"
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleRemove(member.userId)}
                    className="text-xs font-semibold text-danger hover:underline"
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {invites.length > 0 && (
        <div className="rounded-lg border border-border bg-surface/60 p-4">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Pending invites
          </h4>
          <ul className="flex list-none flex-col gap-2 p-0">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{invite.email}</span>
                  <span className="text-xs text-muted">{invite.role}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleCancel(invite.id)}
                  className="text-xs font-semibold text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
