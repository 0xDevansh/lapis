import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("Accepting invite…");

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await fetch(`/api/invites/${token}/accept`, {
          method: "POST",
          credentials: "include",
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          vaultId?: string;
        };
        if (!res.ok) {
          setStatus("error");
          setMessage(body.error ?? "Could not accept invite");
          return;
        }
        setStatus("ok");
        setMessage("Joined vault. Redirecting…");
        setTimeout(() => navigate(body.vaultId ? `/vault/${body.vaultId}` : "/"), 800);
      } catch (e) {
        setStatus("error");
        setMessage((e as Error).message);
      }
    })();
  }, [token, navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas p-6 text-ink">
      <p className={status === "error" ? "text-danger" : "text-muted"}>{message}</p>
      {status === "error" && (
        <Link to="/" className="text-sm text-accent hover:underline">
          Back to vaults
        </Link>
      )}
    </div>
  );
}
