import React, { useEffect, useRef, useState } from "react";
import { GoogleLogo } from "@phosphor-icons/react";
import { Link, useSearchParams } from "react-router-dom";
import { BrandLockup } from "../components/BrandLockup";
import { useToast } from "../components/ui/Toast";
import * as api from "../api";

interface AuthPageProps {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (name: string, email: string, password: string) => Promise<void>;
  onSignInWithGoogle: (callbackURL?: string) => Promise<void>;
  error: string | null;
  loading: boolean;
}

function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === "account_not_linked") {
    return "This email already uses another sign-in method. Sign in with that method first.";
  }
  if (code === "email_doesn't_match" || code === "different_emails_not_allowed") {
    return "Google returned a different email address, so the accounts were not linked.";
  }
  return "Google sign-in failed. Please try again.";
}

export default function AuthPage({
  onSignIn,
  onSignUp,
  onSignInWithGoogle,
  error,
  loading,
}: AuthPageProps) {
  const { toast } = useToast();
  const [params] = useSearchParams();
  const shownOAuthError = useRef<string | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("mode") === "signup" ? "signup" : "signin"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    setMode(params.get("mode") === "signup" ? "signup" : "signin");
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAuthProviders()
      .then((providers) => {
        if (!cancelled) setGoogleEnabled(providers.google);
      })
      .catch(() => {
        if (!cancelled) setGoogleEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const callbackError = oauthErrorMessage(params.get("error"));
  useEffect(() => {
    if (!callbackError || shownOAuthError.current === callbackError) return;
    shownOAuthError.current = callbackError;
    toast(callbackError, { tone: "error" });
  }, [callbackError, toast]);

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
      const message = (err as Error).message;
      setLocalError(message);
      toast(message, { tone: "error" });
    }
  }

  async function handleGoogleSignIn() {
    setLocalError(null);
    try {
      const redirect = params.get("redirect");
      await onSignInWithGoogle(
        redirect && redirect.startsWith("/") && !redirect.startsWith("//")
          ? redirect
          : "/"
      );
    } catch (err) {
      const message = (err as Error).message;
      setLocalError(message);
      toast(message, { tone: "error" });
    }
  }

  const displayError = localError ?? error ?? callbackError;

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

        {googleEnabled && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <div className="h-px flex-1 bg-border" />
              or
              <div className="h-px flex-1 bg-border" />
            </div>

            <button
              className="flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-elevated disabled:opacity-60"
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
            >
              <GoogleLogo size={18} weight="bold" aria-hidden="true" />
              Continue with Google
            </button>
          </>
        )}
      </div>
    </div>
  );
}
