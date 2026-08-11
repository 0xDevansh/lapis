import { useEffect, useRef, useState } from "react";
import {
  DeviceMobile,
  GithubLogo,
  DownloadSimple,
  Copy,
  Check,
  X,
  Sun,
  Moon,
  Plugs,
} from "@phosphor-icons/react";
import * as api from "../../api";
import { useToast } from "../ui/Toast";
import GitHubRemotePanel from "../GitHubRemotePanel";
import McpSettingsPanel from "../McpSettingsPanel";
import type { Theme } from "../../hooks/useTheme";

type SettingsTab = "devices" | "github" | "mcp" | "export" | "appearance";

interface SettingsPopoverProps {
  vaultId: string;
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  exportUrl: string;
  /** Anchor element for positioning (settings button). */
  anchorRef: React.RefObject<HTMLElement | null>;
}

export default function SettingsPopover({
  vaultId,
  open,
  onClose,
  theme,
  onToggleTheme,
  exportUrl,
  anchorRef,
}: SettingsPopoverProps) {
  const [tab, setTab] = useState<SettingsTab>("devices");
  const panelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "devices", label: "Devices", icon: <DeviceMobile size={16} weight="duotone" /> },
    { id: "github", label: "GitHub", icon: <GithubLogo size={16} weight="duotone" /> },
    { id: "mcp", label: "MCP", icon: <Plugs size={16} weight="duotone" /> },
    { id: "export", label: "Export", icon: <DownloadSimple size={16} /> },
    { id: "appearance", label: "Theme", icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} /> },
  ];

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      className="absolute right-2 top-11 z-50 flex w-[min(460px,calc(100vw-1rem))] max-h-[min(620px,calc(100vh-4rem))] flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              "flex flex-1 items-center justify-center gap-1.5 rounded-t-md px-2 py-2 text-[12px] font-medium transition-colors",
              tab === t.id
                ? "bg-surface text-ink"
                : "text-muted hover:bg-hover hover:text-ink",
            ].join(" ")}
          >
            <span className={tab === t.id ? "text-accent-soft" : ""}>{t.icon}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "devices" && <DevicesSettings vaultId={vaultId} toast={toast} />}
        {tab === "github" && <GitHubRemotePanel vaultId={vaultId} defaultOpen />}
        {tab === "mcp" && <McpSettingsPanel vaultId={vaultId} compact />}
        {tab === "export" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Download a zip of every file in this vault.
            </p>
            <a
              href={exportUrl}
              download
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:opacity-90"
            >
              <DownloadSimple size={16} /> Download vault
            </a>
          </div>
        )}
        {tab === "appearance" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Switch between light and dark themes.</p>
            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-hover"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              Use {theme === "dark" ? "light" : "dark"} theme
            </button>
          </div>
        )}
      </div>
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
      <div>
        <p className="mb-2 text-sm text-muted">
          Paste the vault link in Obsidian → Settings → Lapis, then approve the code below.
        </p>
        <button
          type="button"
          onClick={() => void copyVaultLink()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-hover"
        >
          <Copy size={14} /> Copy vault link
        </button>
      </div>

      <div>
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">
          Pending
        </h4>
        {!pending ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-[13px] text-muted">No pending requests.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.userCode}
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2"
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

      <div>
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">
          Connected
        </h4>
        {!devices ? (
          <p className="text-[13px] text-muted">Loading…</p>
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
    </div>
  );
}
