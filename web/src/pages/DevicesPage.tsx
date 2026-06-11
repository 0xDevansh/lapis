/**
 * DevicesPage — manage connected plugin devices for a vault.
 *
 * Accessible via the "Devices" link in the vault browser sidebar.
 * Shows:
 *   - Pending device-code flows (with Approve / Deny actions)
 *   - Connected devices (with Revoke and internals toggle)
 */

import React, { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../api";

export default function DevicesPage() {
  const { id: vaultId } = useParams<{ id: string }>();
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
      alert((e as Error).message);
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
      alert((e as Error).message);
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
      alert((e as Error).message);
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
      alert((e as Error).message);
    } finally {
      setBusy(null);
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

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <Link to={`/vault/${vaultId}`} style={styles.back}>
          ← Back to vault
        </Link>
        <h1 style={styles.title}>{vault?.name ?? "…"} — Connected Devices</h1>
      </header>

      {error && <p style={styles.err}>{error}</p>}

      {/* ── Pending approvals ─────────────────────────────────────────────── */}
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Pending Approvals</h2>
        {!pending ? (
          <p style={styles.muted}>Loading…</p>
        ) : pending.length === 0 ? (
          <p style={styles.muted}>No pending connection requests.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Code</th>
                <th style={styles.th}>Device name</th>
                <th style={styles.th}>Requested</th>
                <th style={styles.th}>Expires</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.userCode}>
                  <td style={{ ...styles.td, ...styles.code }}>{p.userCode}</td>
                  <td style={styles.td}>{p.deviceName}</td>
                  <td style={styles.td}>{formatDate(p.createdAt)}</td>
                  <td style={styles.td}>{formatDate(p.expiresAt)}</td>
                  <td style={{ ...styles.td, ...styles.actions }}>
                    <button
                      style={styles.btnApprove}
                      disabled={busy === p.userCode}
                      onClick={() => handleApprove(p.userCode)}
                    >
                      Approve
                    </button>
                    <button
                      style={styles.btnDeny}
                      disabled={busy === p.userCode}
                      onClick={() => handleDeny(p.userCode)}
                    >
                      Deny
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Connected devices ─────────────────────────────────────────────── */}
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Connected Devices</h2>
        <p style={styles.help}>
          To connect a new device, install the Lapis Obsidian plugin and follow the connection flow.
          The plugin will display a code matching one of the "Pending Approvals" above.
        </p>
        {!devices ? (
          <p style={styles.muted}>Loading…</p>
        ) : devices.length === 0 ? (
          <p style={styles.muted}>No connected devices yet.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Device name</th>
                <th style={styles.th}>Connected</th>
                <th style={styles.th}>Last seen</th>
                <th style={styles.th}>Vault Internals</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td style={styles.td}>{d.deviceName}</td>
                  <td style={styles.td}>{formatDate(d.createdAt)}</td>
                  <td style={styles.td}>{formatDate(d.lastSeenAt)}</td>
                  <td style={styles.td}>
                    <button
                      style={d.receiveInternals ? styles.toggleOn : styles.toggleOff}
                      disabled={busy === d.id}
                      onClick={() => handleToggleInternals(d)}
                      title="Toggle whether this device receives .obsidian and other vault-internal files"
                    >
                      {d.receiveInternals ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td style={{ ...styles.td, ...styles.actions }}>
                    <button
                      style={styles.btnRevoke}
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

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 780,
    margin: "0 auto",
    padding: "2rem 1.5rem",
    fontFamily: "var(--font-sans)",
  },
  header: {
    marginBottom: "2rem",
  },
  back: {
    fontSize: "0.85rem",
    color: "#6b6b6b",
    textDecoration: "none",
    display: "block",
    marginBottom: "0.5rem",
  },
  title: {
    margin: 0,
    fontSize: "1.4rem",
    fontWeight: 700,
    color: "#1a1a1a",
  },
  err: {
    color: "#c0392b",
    background: "#fdf0ee",
    padding: "0.75rem 1rem",
    borderRadius: 6,
    marginBottom: "1.5rem",
  },
  section: {
    marginBottom: "2.5rem",
  },
  sectionTitle: {
    fontSize: "1rem",
    fontWeight: 700,
    color: "#1a1a1a",
    marginBottom: "0.75rem",
  },
  help: {
    fontSize: "0.85rem",
    color: "#6b6b6b",
    marginBottom: "0.75rem",
  },
  muted: {
    color: "#6b6b6b",
    fontSize: "0.9rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.9rem",
  },
  th: {
    textAlign: "left",
    padding: "0.45rem 0.75rem",
    borderBottom: "2px solid #e0e0e0",
    color: "#6b6b6b",
    fontWeight: 600,
    fontSize: "0.78rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "0.55rem 0.75rem",
    borderBottom: "1px solid #f0f0f0",
    verticalAlign: "middle",
    color: "#1a1a1a",
  },
  code: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.95rem",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "#7c5cbf",
  },
  actions: {
    display: "flex",
    gap: "0.4rem",
    flexWrap: "wrap",
  },
  btnApprove: {
    padding: "0.3rem 0.75rem",
    background: "#2ecc71",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDeny: {
    padding: "0.3rem 0.75rem",
    background: "none",
    color: "#c0392b",
    border: "1px solid #e0dede",
    borderRadius: 4,
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  btnRevoke: {
    padding: "0.3rem 0.75rem",
    background: "none",
    color: "#c0392b",
    border: "1px solid #e0dede",
    borderRadius: 4,
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  toggleOn: {
    padding: "0.25rem 0.6rem",
    background: "#ede8f8",
    color: "#7c5cbf",
    border: "1px solid #c5b0f0",
    borderRadius: 4,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  toggleOff: {
    padding: "0.25rem 0.6rem",
    background: "none",
    color: "#6b6b6b",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    fontSize: "0.78rem",
    cursor: "pointer",
  },
};
