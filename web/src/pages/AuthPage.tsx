import React, { useState } from "react";

interface AuthPageProps {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (name: string, email: string, password: string) => Promise<void>;
  error: string | null;
  loading: boolean;
}

export default function AuthPage({
  onSignIn,
  onSignUp,
  error,
  loading,
}: AuthPageProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    try {
      if (mode === "signin") {
        await onSignIn(email, password);
      } else {
        await onSignUp(name, email, password);
      }
    } catch (err) {
      setLocalError((err as Error).message);
    }
  }

  const displayError = localError ?? error;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.logo}>Lapis</h1>
        <p style={styles.tagline}>Your Obsidian vault, anywhere.</p>

        <div style={styles.tabs}>
          <button
            style={mode === "signin" ? styles.tabActive : styles.tab}
            onClick={() => setMode("signin")}
            type="button"
          >
            Sign in
          </button>
          <button
            style={mode === "signup" ? styles.tabActive : styles.tab}
            onClick={() => setMode("signup")}
            type="button"
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          {mode === "signup" && (
            <input
              style={styles.input}
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          )}
          <input
            style={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
          />
          {displayError && <p style={styles.error}>{displayError}</p>}
          <button style={styles.button} type="submit" disabled={loading}>
            {loading
              ? "..."
              : mode === "signin"
              ? "Sign in"
              : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "#f6f6f6",
    padding: "1rem",
  },
  card: {
    background: "#ffffff",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    padding: "2rem",
    width: "100%",
    maxWidth: 380,
  },
  logo: {
    margin: "0 0 0.25rem",
    fontSize: "1.8rem",
    fontWeight: 700,
    color: "#7c5cbf",
  },
  tagline: {
    margin: "0 0 1.5rem",
    color: "#6b6b6b",
    fontSize: "0.9rem",
  },
  tabs: {
    display: "flex",
    gap: 4,
    marginBottom: "1.25rem",
  },
  tab: {
    flex: 1,
    padding: "0.45rem",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    background: "#f6f6f6",
    color: "#6b6b6b",
    fontSize: "0.9rem",
  },
  tabActive: {
    flex: 1,
    padding: "0.45rem",
    border: "1px solid #7c5cbf",
    borderRadius: 6,
    background: "#7c5cbf",
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  input: {
    padding: "0.6rem 0.75rem",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontSize: "0.95rem",
    outline: "none",
    width: "100%",
  },
  button: {
    padding: "0.65rem",
    background: "#7c5cbf",
    color: "#ffffff",
    border: "none",
    borderRadius: 6,
    fontSize: "0.95rem",
    fontWeight: 600,
    marginTop: "0.25rem",
  },
  error: {
    margin: 0,
    color: "#c0392b",
    fontSize: "0.85rem",
  },
};
