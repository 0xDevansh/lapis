/**
 * Thin fetch wrapper for Lapis API calls.
 * All requests are same-origin and use cookie-based auth.
 */

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
}

export async function signUp(name: string, email: string, password: string): Promise<User> {
  return apiFetch<User>("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
}

export async function signIn(email: string, password: string): Promise<User> {
  return apiFetch<User>("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function signOut(): Promise<void> {
  await apiFetch<unknown>("/api/auth/sign-out", { method: "POST" });
}

export async function getSession(): Promise<{ user: User } | null> {
  try {
    return await apiFetch<{ user: User }>("/api/auth/get-session");
  } catch {
    return null;
  }
}

// ── Vaults ────────────────────────────────────────────────────────────────────

export interface Vault {
  id: string;
  name: string;
  createdAt: string;
}

export async function listVaults(): Promise<Vault[]> {
  return apiFetch<Vault[]>("/api/vaults");
}

export async function createVault(name: string): Promise<Vault> {
  return apiFetch<Vault>("/api/vaults", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getVault(id: string): Promise<Vault> {
  return apiFetch<Vault>(`/api/vaults/${id}`);
}
