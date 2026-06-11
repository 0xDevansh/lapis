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

// ── Vault Content ─────────────────────────────────────────────────────────────

export interface ManifestEntry {
  path: string;
  r2Key: string;
  size: number;
  contentType: string;
  updatedAt: string;
}

export interface VaultManifest {
  vaultId: string;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

export async function getManifest(vaultId: string): Promise<VaultManifest> {
  return apiFetch<VaultManifest>(`/api/vaults/${vaultId}/manifest`);
}

/** Fetch the raw text content of a vault file. */
export async function getFileText(vaultId: string, path: string): Promise<string> {
  const res = await fetch(
    `/api/vaults/${vaultId}/files/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    { credentials: "include" }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Return the URL for fetching a vault file (for use in <img> etc.). */
export function fileUrl(vaultId: string, path: string): string {
  return `/api/vaults/${vaultId}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Create or replace a text file (Markdown, plain text). */
export async function putTextFile(
  vaultId: string,
  path: string,
  content: string
): Promise<ManifestEntry> {
  return apiFetch<ManifestEntry>(
    `/api/vaults/${vaultId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
}

/** Upload a binary file (uses raw body, not JSON wrapper). */
export async function uploadFile(
  vaultId: string,
  path: string,
  file: File
): Promise<ManifestEntry> {
  const res = await fetch(
    `/api/vaults/${vaultId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<ManifestEntry>;
}

/** Rename or move a file. */
export async function renameFile(
  vaultId: string,
  oldPath: string,
  newPath: string
): Promise<ManifestEntry> {
  return apiFetch<ManifestEntry>(
    `/api/vaults/${vaultId}/files/${oldPath.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PATCH",
      body: JSON.stringify({ newPath }),
    }
  );
}

/** Delete a file. */
export async function deleteFile(
  vaultId: string,
  path: string
): Promise<void> {
  await apiFetch<unknown>(
    `/api/vaults/${vaultId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "DELETE" }
  );
}

// ── Search, backlinks, tags (Slice 06) ────────────────────────────────────────

export interface SearchResult {
  path: string;
  snippet: string;
}

export async function searchVault(
  vaultId: string,
  q: string
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q });
  return apiFetch<SearchResult[]>(`/api/vaults/${vaultId}/search?${params}`);
}

export interface BacklinkResult {
  sourcePath: string;
}

export async function getBacklinks(
  vaultId: string,
  path: string
): Promise<BacklinkResult[]> {
  const params = new URLSearchParams({ path });
  return apiFetch<BacklinkResult[]>(`/api/vaults/${vaultId}/backlinks?${params}`);
}

export interface TagResult {
  tag: string;
  count: number;
}

export async function getVaultTags(vaultId: string): Promise<TagResult[]> {
  return apiFetch<TagResult[]>(`/api/vaults/${vaultId}/tags`);
}
