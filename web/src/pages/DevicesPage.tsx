/**
 * DevicesPage — manage connected plugin devices for a vault.
 *
 * Accessible via the "Devices" link in the vault browser sidebar.
 * Shows:
 *   - Pending device-code flows (with Approve / Deny actions)
 *   - Connected devices (with Revoke and internals toggle)
 */

import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Check, X, DeviceMobile, Copy } from "@phosphor-icons/react";
import * as api from "../api";
import { useToast } from "../components/ui/Toast";
import GitHubRemotePanel from "../components/GitHubRemotePanel";

export default function DevicesPage() {
  const { id: vaultId } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [vault, setVault] = useState<api.Vault | null>(null);
  const [pending, setPending] = useState<api.PendingDevice[] | null>(null);
  const [devices, setDevices] = useState<api.Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // id of in-progress action

  const reload = useCallback(async () => {
    if (!vaultId) return;
    try {
      const [p, d] = await Promise.all([
        api.getPendingDevices(vaultId),
        api.listDevices(vaultId),
      ]);
      setPending(p);
      setDevices(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [vaultId]);

  useEffect(() => {
    if (!vaultId) return;
    api.getVault(vaultId).then(setVault).catch(() => {});
    reload();
    // Poll pending codes every 5s so the owner sees new requests promptly
    const interval = setInterval(reload, 5000);
    return () => clearInterval(interval);
  }, [vaultId, reload]);

  async function handleApprove(userCode: string) {
    if (!vaultId) return;
    setBusy(userCode);
    try {
      await api.approveDevice(vaultId, userCode);
      await reload();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleDeny(userCode: string) {
    if (!vaultId) return;
    setBusy(userCode);
    try {
      await api.denyDevice(vaultId, userCode);
      await reload();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke(deviceId: string) {
    if (!vaultId || !confirm("Revoke this device? It will no longer be able to sync.")) return;
    setBusy(deviceId);
    try {
      await api.revokeDevice(vaultId, deviceId);
      await reload();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleToggleInternals(device: api.Device) {
    if (!vaultId) return;
    setBusy(device.id);
    try {
      await api.updateDevice(vaultId, device.id, {
        receiveInternals: !device.receiveInternals,
      });
      await reload();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function vaultLink(): string {
    if (!vaultId) return "";
    return `${window.location.origin}/vault/${vaultId}`;
  }

  async function copyVaultLink() {
    const link = vaultLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Vault link copied — paste it in Obsidian → Settings → Lapis", { tone: "success", duration: 4000 });
    } catch {
      toast("Could not copy link", { tone: "error" });
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  const th =
    "text-left px-3 py-2 border-b-2 border-border text-faint font-semibold text-xs uppercase tracking-wider whitespace-nowrap";
  const td = "px-3 py-2.5 border-b border-border/60 align-middle text-ink";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 font-sans text-ink">
      <header className="mb-8">
        <Link
          to={`/vault/${vaultId}`}
          className="mb-2 flex w-fit items-center gap-1.5 text-sm text-muted no-underline transition-colors hover:text-ink"
        >
          <ArrowLeft size={16} />
          Back to vault
        </Link>
        <h1 className="m-0 text-2xl font-bold">
          {vault?.name ?? "…"} — Devices &amp; Sync
        </h1>
      </header>

      <section className="mb-8 rounded-lg border border-border bg-surface/50 px-4 py-4">
        <h2 className="mb-2 text-base font-bold">Connect Obsidian</h2>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>In Obsidian, open <strong className="text-ink">Settings → Lapis sync</strong></li>
          <li>Paste your vault link and click <strong className="text-ink">Connect to vault</strong></li>
          <li>Enter the approval code from Obsidian below and click Approve</li>
        </ol>
        <button
          type="button"
          onClick={() => void copyVaultLink()}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-accent/40 hover:text-accent-soft"
        >
          <Copy size={16} />
          Copy vault link for Obsidian
        </button>
      </section>

      {api.isVaultOwner(vault?.role) && vaultId && <GitHubRemotePanel vaultId={vaultId} />}

      {error && (
        <p className="mb-6 rounded border border-danger/30 bg-danger/10 px-4 py-3 text-danger">
          {error}
        </p>
      )}

      {/* ── Pending approvals ─────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-3 text-base font-bold">Pending Approvals</h2>
        {!pending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted">No pending connection requests.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={th}>Code</th>
                <th className={th}>Device name</th>
                <th className={th}>Requested</th>
                <th className={th}>Expires</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.userCode}>
                  <td className={`${td} font-mono font-bold tracking-wider text-accent-soft`}>
                    {p.userCode}
                  </td>
                  <td className={td}>{p.deviceName}</td>
                  <td className={td}>{formatDate(p.createdAt)}</td>
                  <td className={td}>{formatDate(p.expiresAt)}</td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        className="flex items-center gap-1 rounded-sm bg-success px-3 py-1.5 text-xs font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                        disabled={busy === p.userCode}
                        onClick={() => handleApprove(p.userCode)}
                      >
                        <Check size={14} weight="bold" />
                        Approve
                      </button>
                      <button
                        className="flex items-center gap-1 rounded-sm border border-border px-3 py-1.5 text-xs text-danger transition-colors hover:border-danger/50 disabled:opacity-50"
                        disabled={busy === p.userCode}
                        onClick={() => handleDeny(p.userCode)}
                      >
                        <X size={14} weight="bold" />
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Connected devices ─────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-3 text-base font-bold">Connected Devices</h2>
        <p className="mb-3 text-sm text-muted">
          To connect a new device, install the Lapis Obsidian plugin and follow the connection flow.
          The plugin will display a code matching one of the "Pending Approvals" above.
        </p>
        {!devices ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : devices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-10 text-center">
            <DeviceMobile size={28} weight="duotone" className="mx-auto mb-2 text-faint" />
            <p className="text-sm text-muted">No connected devices yet.</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={th}>Device name</th>
                <th className={th}>Kind</th>
                <th className={th}>Connected</th>
                <th className={th}>Last seen</th>
                <th className={th}>Vault Internals</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className={td}>{d.deviceName}</td>
                  <td className={td}>{d.kind ?? "plugin"}</td>
                  <td className={td}>{formatDate(d.createdAt)}</td>
                  <td className={td}>{formatDate(d.lastSeenAt)}</td>
                  <td className={td}>
                    <button
                      className={
                        d.receiveInternals
                          ? "rounded-sm border border-accent/40 bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent-soft transition-colors disabled:opacity-50"
                          : "rounded-sm border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-50"
                      }
                      disabled={busy === d.id}
                      onClick={() => handleToggleInternals(d)}
                      title="Toggle whether this device receives .obsidian and other vault-internal files"
                    >
                      {d.receiveInternals ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td className={td}>
                    <button
                      className="rounded-sm border border-border px-3 py-1.5 text-xs text-danger transition-colors hover:border-danger/50 disabled:opacity-50"
                      disabled={busy === d.id}
                      onClick={() => handleRevoke(d.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
