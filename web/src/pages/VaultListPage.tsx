import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  Check,
  CubeTransparent,
  EnvelopeSimple,
  Plus,
  Vault as VaultIcon,
  CaretRight,
  X,
} from "@phosphor-icons/react";
import * as api from "../api";

interface VaultListPageProps {
  user: api.User;
  onSignOut: () => void;
}

function roleLabel(role?: api.VaultRole): string {
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return "Owner";
}

export default function VaultListPage({ user, onSignOut }: VaultListPageProps) {
  const [vaults, setVaults] = useState<api.Vault[]>([]);
  const [archivedVaults, setArchivedVaults] = useState<api.Vault[]>([]);
  const [invites, setInvites] = useState<api.VaultInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listVaults(), api.listArchivedVaults(), api.listInvites()])
      .then(([active, archived, pending]) => {
        setVaults(active);
        setArchivedVaults(archived);
        setInvites(pending);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const vault = await api.createVault(name);
      setVaults((v) => [vault, ...v]);
      setNewName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore(vaultId: string) {
    setRestoring(vaultId);
    setError(null);
    try {
      const restored = await api.restoreVault(vaultId);
      setArchivedVaults((items) => items.filter((vault) => vault.id !== vaultId));
      setVaults((items) => [restored, ...items]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  async function handleAccept(invite: api.VaultInvite) {
    setInviteBusy(invite.id);
    setError(null);
    try {
      const accepted = await api.acceptInvite(invite.id);
      setInvites((items) => items.filter((item) => item.id !== invite.id));
      setVaults((items) => {
        if (items.some((vault) => vault.id === accepted.vaultId)) return items;
        return [
          {
            id: accepted.vaultId,
            name: accepted.vaultName,
            createdAt: invite.createdAt,
            role: accepted.role,
          },
          ...items,
        ];
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInviteBusy(null);
    }
  }

  async function handleReject(inviteId: string) {
    setInviteBusy(inviteId);
    setError(null);
    try {
      await api.rejectInvite(inviteId);
      setInvites((items) => items.filter((item) => item.id !== inviteId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInviteBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-border bg-secondary px-6 py-3">
        <div className="flex items-center gap-2">
          <CubeTransparent size={22} weight="duotone" className="text-accent" />
          <span className="text-lg font-bold">Lapis</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted">{user.email}</span>
          <button
            className="rounded border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-ink"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-6 py-8">
        <h2 className="mb-5 text-xl font-bold">Your Web Vaults</h2>

        <form onSubmit={handleCreate} className="mb-5 flex gap-2">
          <input
            className="flex-1 rounded border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            type="text"
            placeholder="New vault name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <button
            className="flex items-center gap-1.5 whitespace-nowrap rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-soft disabled:opacity-60"
            type="submit"
            disabled={creating}
          >
            <Plus size={16} weight="bold" />
            {creating ? "Creating..." : "Create vault"}
          </button>
        </form>

        {error && <p className="mb-4 text-sm text-danger">{error}</p>}

        {loading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : (
          <>
            {invites.length > 0 && (
              <section className="mb-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-faint">
                  <EnvelopeSimple size={16} /> Invites
                </h3>
                <ul className="flex list-none flex-col gap-2 p-0">
                  {invites.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">
                          {invite.vaultName}
                        </span>
                        <span className="text-sm text-muted">
                          Invited as {roleLabel(invite.role).toLowerCase()}
                          {invite.invitedByEmail ? ` by ${invite.invitedByEmail}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          disabled={inviteBusy === invite.id}
                          onClick={() => void handleAccept(invite)}
                          className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent-soft disabled:opacity-50"
                        >
                          <Check size={14} weight="bold" />
                          Accept
                        </button>
                        <button
                          type="button"
                          disabled={inviteBusy === invite.id}
                          onClick={() => void handleReject(invite.id)}
                          className="inline-flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-hover disabled:opacity-50"
                        >
                          <X size={14} weight="bold" />
                          Decline
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {vaults.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-12 text-center">
                <VaultIcon size={32} weight="duotone" className="mx-auto mb-2 text-faint" />
                <p className="text-sm text-muted">No active vaults. Create one above.</p>
              </div>
            ) : (
              <ul className="flex list-none flex-col gap-2 p-0">
                {vaults.map((vault) => (
                  <li key={vault.id}>
                    <Link
                      to={`/vault/${vault.id}`}
                      className="group flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-ink no-underline transition-colors hover:border-border-strong hover:bg-elevated"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <VaultIcon size={20} weight="duotone" className="text-accent-soft" />
                        <span className="truncate font-semibold">{vault.name}</span>
                        {vault.role && vault.role !== "owner" && (
                          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                            {roleLabel(vault.role)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm text-muted">
                          {new Date(vault.createdAt).toLocaleDateString()}
                        </span>
                        <CaretRight
                          size={16}
                          className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted"
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {archivedVaults.length > 0 && (
              <section className="mt-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-faint">
                  <Archive size={16} /> Archived
                </h3>
                <ul className="flex list-none flex-col gap-2 p-0">
                  {archivedVaults.map((vault) => (
                    <li
                      key={vault.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/70 px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{vault.name}</span>
                        <span className="text-sm text-muted">
                          Archived{" "}
                          {vault.archivedAt
                            ? new Date(vault.archivedAt).toLocaleDateString()
                            : ""}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={restoring === vault.id}
                        onClick={() => void handleRestore(vault.id)}
                        className="shrink-0 rounded border border-border px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-hover disabled:opacity-50"
                      >
                        {restoring === vault.id ? "Restoring..." : "Restore"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
