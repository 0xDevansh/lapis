import { useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Plugs, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { authClient } from "../lib/auth-client";
import type * as api from "../api";
import { useToast } from "../components/ui/Toast";

interface McpConsentPageProps {
  user: api.User;
}

export default function McpConsentPage({ user }: McpConsentPageProps) {
  const [params] = useSearchParams();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
  const clientId = params.get("client_id") ?? "Unknown client";
  const scopes = useMemo(
    () => (params.get("scope") ?? "").split(/\s+/).filter(Boolean),
    [params]
  );

  if (!params.get("client_id")) {
    return <Navigate to="/" replace />;
  }

  async function decide(accept: boolean) {
    setBusy(accept ? "accept" : "deny");
    try {
      const { error } = await authClient.oauth2.consent({
        accept,
        scope: scopes.join(" ") || undefined,
      });
      if (error) throw new Error(error.message ?? "Could not complete MCP consent");
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 text-ink">
      <main className="w-full max-w-lg rounded-2xl border border-border bg-elevated p-6 shadow-2xl">
        <div className="mb-5 flex items-start gap-3">
          <div className="rounded-xl bg-accent/10 p-2 text-accent-soft">
            <Plugs size={26} weight="duotone" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Connect MCP client</h1>
            <p className="mt-1 text-sm text-muted">
              You are signed in as {user.email}. Allow this client to access Lapis
              vaults you have explicitly enabled for MCP.
            </p>
          </div>
        </div>

        <section className="rounded-lg border border-border bg-surface/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">
            Client
          </p>
          <p className="mt-1 break-all font-mono text-sm text-ink">{clientId}</p>
        </section>

        <section className="mt-4 rounded-lg border border-border bg-surface/70 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <ShieldCheck size={18} className="text-success" /> Requested access
          </p>
          {scopes.length === 0 ? (
            <p className="text-sm text-muted">Basic MCP connection metadata.</p>
          ) : (
            <ul className="space-y-1 text-sm text-muted">
              {scopes.map((scope) => (
                <li key={scope} className="font-mono">
                  {scope}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-canvas p-3 text-sm text-muted">
          <WarningCircle size={18} className="mt-0.5 shrink-0 text-accent-soft" />
          Vault access is still controlled per vault in Settings. Disabled or
          archived vaults are not exposed to this client.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide(false)}
            className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            {busy === "deny" ? "Denying..." : "Deny"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide(true)}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "accept" ? "Connecting..." : "Allow"}
          </button>
        </div>
      </main>
    </div>
  );
}
