import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logo}>Lapis</span>
        <div style={styles.headerRight}>
          <span style={styles.userEmail}>{user.email}</span>
          <button style={styles.signOut} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main style={styles.main}>
        <h2 style={styles.heading}>Your Web Vaults</h2>

        <form onSubmit={handleCreate} style={styles.createForm}>
          <input
            style={styles.input}
            type="text"
            placeholder="New vault name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <button style={styles.createButton} type="submit" disabled={creating}>
            {creating ? "Creating..." : "Create vault"}
          </button>
        </form>

        {error && <p style={styles.error}>{error}</p>}

        {loading ? (
          <p style={styles.muted}>Loading...</p>
        ) : vaults.length === 0 ? (
          <p style={styles.muted}>No vaults yet. Create one above.</p>
        ) : (
          <ul style={styles.list}>
            {vaults.map((vault) => (
              <li key={vault.id} style={styles.item}>
                <Link to={`/vault/${vault.id}`} style={styles.vaultLink}>
                  <span style={styles.vaultName}>{vault.name}</span>
                  <span style={styles.vaultDate}>
                    {new Date(vault.createdAt).toLocaleDateString()}
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

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.85rem 1.5rem",
    borderBottom: "1px solid #e0e0e0",
    background: "#ffffff",
  },
  logo: {
    fontWeight: 700,
    fontSize: "1.2rem",
    color: "#7c5cbf",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
  },
  userEmail: {
    color: "#6b6b6b",
    fontSize: "0.9rem",
  },
  signOut: {
    background: "none",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    padding: "0.3rem 0.75rem",
    fontSize: "0.85rem",
    color: "#6b6b6b",
  },
  main: {
    padding: "2rem 1.5rem",
    maxWidth: 640,
    width: "100%",
    margin: "0 auto",
  },
  heading: {
    margin: "0 0 1.25rem",
    fontWeight: 700,
    fontSize: "1.3rem",
  },
  createForm: {
    display: "flex",
    gap: "0.6rem",
    marginBottom: "1.25rem",
  },
  input: {
    flex: 1,
    padding: "0.55rem 0.75rem",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontSize: "0.95rem",
  },
  createButton: {
    padding: "0.55rem 1rem",
    background: "#7c5cbf",
    color: "#ffffff",
    border: "none",
    borderRadius: 6,
    fontWeight: 600,
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
  },
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  item: {
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    overflow: "hidden",
  },
  vaultLink: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.85rem 1rem",
    color: "inherit",
    textDecoration: "none",
    background: "#ffffff",
    transition: "background 0.1s",
  },
  vaultName: {
    fontWeight: 600,
  },
  vaultDate: {
    color: "#6b6b6b",
    fontSize: "0.85rem",
  },
  error: {
    color: "#c0392b",
    fontSize: "0.85rem",
    margin: "0 0 1rem",
  },
  muted: {
    color: "#6b6b6b",
    fontSize: "0.9rem",
  },
};
