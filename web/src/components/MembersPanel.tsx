import { useCallback, useEffect, useState } from "react";

export interface VaultMember {
  userId: string;
  role: "owner" | "editor" | "viewer";
  createdAt: string;
  name: string;
  email: string;
}

interface MembersPanelProps {
  vaultId: string;
  canManage: boolean;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export function MembersPanel({ vaultId, canManage }: MembersPanelProps) {
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiJson<VaultMember[]>(`/api/vaults/${vaultId}/members`);
      setMembers(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInviteLink(null);
    try {
      const inv = await apiJson<{ acceptPath: string; token: string }>(
        `/api/vaults/${vaultId}/invites`,
        { method: "POST", body: JSON.stringify({ email, role }) }
      );
      setInviteLink(`${window.location.origin}${inv.acceptPath}`);
      setEmail("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeMember(userId: string) {
    if (!confirm("Remove this member?")) return;
    try {
      await apiJson(`/api/vaults/${vaultId}/members/${userId}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wider text-muted">
        Members
      </h2>
      {loading && <p className="text-sm text-muted">Loading…</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      <ul className="m-0 list-none space-y-2 p-0">
        {members.map((m) => (
          <li
            key={m.userId}
            className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2 text-sm"
          >
            <div>
              <div className="font-medium text-ink">{m.name}</div>
              <div className="text-xs text-muted">{m.email}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase text-muted">{m.role}</span>
              {canManage && m.role !== "owner" && (
                <button
                  type="button"
                  className="text-xs text-danger hover:underline"
                  onClick={() => void removeMember(m.userId)}
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canManage && (
        <form onSubmit={invite} className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="m-0 text-xs text-muted">Invite by email (share the link after creating)</p>
          <input
            className="rounded border border-border bg-canvas px-2 py-1.5 text-sm text-ink"
            type="email"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select
            className="rounded border border-border bg-canvas px-2 py-1.5 text-sm text-ink"
            value={role}
            onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="submit"
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
          >
            Create invite
          </button>
          {inviteLink && (
            <p className="m-0 break-all text-xs text-muted">
              Invite link: <a href={inviteLink}>{inviteLink}</a>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
