/**
 * MCP settings panel — enable, path allow/deny, tool flags, token mint.
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, Plugs, Plus, FloppyDisk } from "@phosphor-icons/react";
import * as api from "../api";
import { useToast } from "./ui/Toast";

interface McpSettingsPanelProps {
  vaultId: string;
  /** Compact layout for SettingsPopover */
  compact?: boolean;
}

function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function listToLines(list: string[]): string {
  return list.join("\n");
}

export default function McpSettingsPanel({ vaultId, compact }: McpSettingsPanelProps) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<api.VaultMcpSettings | null>(null);
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [tokenName, setTokenName] = useState("Cursor");
  const [minted, setMinted] = useState<{ token: string; endpoint: string; name: string } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const s = await api.getMcpSettings(vaultId);
    setSettings(s);
    setAllowText(listToLines(s.allowPaths));
    setDenyText(listToLines(s.denyPaths));
  }, [vaultId]);

  useEffect(() => {
    void reload().catch((e) => setError((e as Error).message));
  }, [reload]);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateMcpSettings(vaultId, {
        enabled: settings.enabled,
        readOnly: settings.readOnly,
        allowPaths: linesToList(allowText),
        denyPaths: linesToList(denyText),
        allowWrite: settings.allowWrite,
        allowSearch: settings.allowSearch,
        allowDelete: settings.allowDelete,
        maxReadBytes: settings.maxReadBytes,
      });
      setSettings(next);
      setAllowText(listToLines(next.allowPaths));
      setDenyText(listToLines(next.denyPaths));
      toast("MCP settings saved", { tone: "success", duration: 1500 });
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function mintToken() {
    setBusy(true);
    try {
      const res = await api.createMcpToken(vaultId, tokenName.trim() || "MCP client");
      setMinted({ token: res.token, endpoint: res.endpoint, name: res.name });
      toast("Token created — copy it now; it won’t be shown again", {
        tone: "info",
        duration: 5000,
      });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, { tone: "success", duration: 1500 });
    } catch {
      toast("Could not copy", { tone: "error" });
    }
  }

  if (error && !settings) {
    return <p className="text-sm text-danger">{error}</p>;
  }
  if (!settings) {
    return <p className="text-sm text-muted">Loading MCP settings…</p>;
  }

  const toggle = (key: keyof api.VaultMcpSettings, value: boolean) => {
    setSettings({ ...settings, [key]: value });
  };

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Plugs size={18} weight="duotone" className="text-accent-soft" />
          <h3 className="m-0 text-sm font-semibold text-ink">Model Context Protocol</h3>
        </div>
        <p className="m-0 text-[13px] text-muted">
          Let Cursor, Claude, and other MCP clients read (and optionally write) this vault through
          the Yjs-backed API. Disabled by default.
        </p>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <span className="text-sm text-ink">Enable MCP endpoint</span>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => toggle("enabled", e.target.checked)}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["readOnly", "Read-only (block all writes)"],
            ["allowWrite", "Allow write_file"],
            ["allowSearch", "Allow search"],
            ["allowDelete", "Allow delete_file"],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-2 text-[13px]"
          >
            <span className="text-ink">{label}</span>
            <input
              type="checkbox"
              checked={Boolean(settings[key])}
              disabled={key !== "readOnly" && settings.readOnly && key !== "allowSearch"}
              onChange={(e) => toggle(key, e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
          </label>
        ))}
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-faint">
          Allow paths
        </label>
        <p className="mb-1.5 text-[12px] text-muted">
          One per line. Empty = all paths (minus deny). Use prefixes like <code>notes/</code> or{" "}
          <code>Projects/*</code>.
        </p>
        <textarea
          value={allowText}
          onChange={(e) => setAllowText(e.target.value)}
          rows={compact ? 3 : 4}
          className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] text-ink"
          placeholder={"notes/\nProjects/"}
        />
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-faint">
          Deny paths
        </label>
        <p className="mb-1.5 text-[12px] text-muted">
          Always blocked. Defaults hide <code>.obsidian/</code>, trash, and sync conflicts.
        </p>
        <textarea
          value={denyText}
          onChange={(e) => setDenyText(e.target.value)}
          rows={compact ? 3 : 4}
          className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] text-ink"
        />
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-faint">
          Max read/write bytes
        </label>
        <input
          type="number"
          min={1024}
          max={8388608}
          value={settings.maxReadBytes}
          onChange={(e) =>
            setSettings({ ...settings, maxReadBytes: Number(e.target.value) || 1048576 })
          }
          className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-ink"
        />
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
      >
        <FloppyDisk size={16} /> Save MCP settings
      </button>

      <div className="border-t border-border pt-4">
        <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-faint">
          Connection
        </h4>
        <p className="mb-2 break-all font-mono text-[11px] text-muted">{settings.endpoint}</p>
        <button
          type="button"
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-accent-soft hover:underline"
          onClick={() => void copy(settings.endpoint, "Endpoint")}
        >
          <Copy size={12} /> Copy endpoint
        </button>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[8rem] flex-1">
            <label className="mb-1 block text-[12px] text-muted">Token name</label>
            <input
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink"
              placeholder="Cursor"
            />
          </div>
          <button
            type="button"
            disabled={busy || !settings.enabled}
            onClick={() => void mintToken()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-50"
            title={!settings.enabled ? "Enable MCP first" : "Mint token"}
          >
            <Plus size={14} /> Mint token
          </button>
        </div>

        {minted && (
          <div className="mt-3 space-y-2 rounded-md border border-accent/30 bg-accent/10 p-3">
            <p className="m-0 text-[12px] text-ink">
              Token for <strong>{minted.name}</strong> (copy once):
            </p>
            <code className="block break-all rounded bg-surface px-2 py-1.5 font-mono text-[11px] text-ink">
              {minted.token}
            </code>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[12px] text-accent-soft hover:underline"
              onClick={() => void copy(minted.token, "Token")}
            >
              <Copy size={12} /> Copy token
            </button>
            <pre className="m-0 overflow-x-auto rounded bg-surface p-2 font-mono text-[10px] text-muted">
              {`{
  "mcpServers": {
    "lapis": {
      "url": "${minted.endpoint}",
      "headers": {
        "Authorization": "Bearer ${minted.token}"
      }
    }
  }
}`}
            </pre>
          </div>
        )}
      </div>

      {!compact && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">
            More setting ideas
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] text-muted">
            <li>Per-token path scopes (Cursor vs Claude get different folders)</li>
            <li>Token expiry / rotation reminders</li>
            <li>Rate limits (tools/min) and max writes per hour</li>
            <li>Audit log of MCP tool calls in the control panel</li>
            <li>Require human approval for delete / large writes</li>
            <li>Block binary uploads; markdown-only mode</li>
            <li>OAuth for MCP (instead of long-lived bearer tokens)</li>
          </ul>
        </details>
      )}
    </div>
  );
}
