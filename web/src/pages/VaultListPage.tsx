import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CubeTransparent, Plus, Vault as VaultIcon, CaretRight } from "@phosphor-icons/react";
import * as api from "../api";

interface VaultListPageProps {
  user: api.User;
  onSignOut: () => void;
}

export default function VaultListPage({ user, onSignOut }: VaultListPageProps) {
  const [vaults, setVaults] = useState<api.Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listVaults()
      .then(setVaults)
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
        ) : vaults.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-12 text-center">
            <VaultIcon size={32} weight="duotone" className="mx-auto mb-2 text-faint" />
            <p className="text-sm text-muted">No vaults yet. Create one above.</p>
          </div>
        ) : (
          <ul className="flex list-none flex-col gap-2 p-0">
            {vaults.map((vault) => (
              <li key={vault.id}>
                <Link
                  to={`/vault/${vault.id}`}
                  className="group flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-ink no-underline transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <span className="flex items-center gap-3">
                    <VaultIcon size={20} weight="duotone" className="text-accent-soft" />
                    <span className="font-semibold">{vault.name}</span>
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
      </main>
    </div>
  );
}
