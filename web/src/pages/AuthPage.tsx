import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BrandLockup } from "../components/BrandLockup";

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
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("mode") === "signup" ? "signup" : "signin"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setMode(params.get("mode") === "signup" ? "signup" : "signin");
  }, [params]);

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

  const tabBase =
    "flex-1 rounded px-3 py-2 text-sm font-medium transition-colors";
  const tabActive = "bg-accent text-on-accent";
  const tabIdle = "bg-surface text-muted hover:text-ink hover:bg-elevated";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas p-4">
      <div className="mb-4 w-full max-w-sm">
        <Link to="/" className="text-sm text-muted transition-colors hover:text-ink">
          ← Back
        </Link>
      </div>
      <div className="w-full max-w-sm rounded-lg border border-border bg-secondary p-8 shadow-[0_24px_60px_var(--shadow)]">
        <BrandLockup
          size={28}
          className="mb-1"
          textClassName="text-2xl font-bold tracking-wide text-ink"
        />
        <p className="mb-6 text-sm text-muted">Your Obsidian vault, anywhere.</p>

        <div className="mb-5 flex gap-1" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "signin"}
            className={`${tabBase} ${mode === "signin" ? tabActive : tabIdle}`}
            onClick={() => setMode("signin")}
            type="button"
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === "signup"}
            className={`${tabBase} ${mode === "signup" ? tabActive : tabIdle}`}
            onClick={() => setMode("signup")}
            type="button"
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <input
              className="w-full rounded border border-border bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          )}
          <input
            className="w-full rounded border border-border bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            className="w-full rounded border border-border bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
          />
          {displayError && (
            <p className="m-0 text-sm text-danger">{displayError}</p>
          )}
          <button
            className="mt-1 rounded bg-accent px-3 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-soft disabled:opacity-60"
            type="submit"
            disabled={loading}
          >
            {loading
              ? "..."
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-muted">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        
      </div>
    </div>
  );
}
