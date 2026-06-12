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
  /** Monotonic revision counter, incremented on every accepted write. */
  revision: number;
}

export interface ConflictResponse {
  conflict: true;
  conflictPath: string;
  entry: ManifestEntry;
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
  content: string,
  options?: { baseRevision?: number; baseContent?: string }
): Promise<ManifestEntry | ConflictResponse> {
  return apiFetch<ManifestEntry | ConflictResponse>(
    `/api/vaults/${vaultId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(options?.baseRevision !== undefined ? { "X-Base-Revision": String(options.baseRevision) } : {}),
      },
      body: JSON.stringify({ content, baseContent: options?.baseContent }),
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

// ── Device-code plugin connection (Slice 07) ──────────────────────────────────

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export async function requestDeviceCode(
  vaultId: string,
  deviceName: string
): Promise<DeviceCodeResponse> {
  return apiFetch<DeviceCodeResponse>("/api/device-auth/request", {
    method: "POST",
    body: JSON.stringify({ vaultId, deviceName }),
  });
}

export interface DeviceTokenResponse {
  status?: "pending";
  token?: string;
  error?: string;
}

/** Poll for device approval. Returns token when approved. */
export async function pollDeviceToken(
  deviceCode: string
): Promise<DeviceTokenResponse> {
  const res = await fetch("/api/device-auth/token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  return res.json() as Promise<DeviceTokenResponse>;
}

export interface PendingDevice {
  userCode: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}

export async function getPendingDevices(vaultId: string): Promise<PendingDevice[]> {
  return apiFetch<PendingDevice[]>(`/api/vaults/${vaultId}/devices/pending`);
}

export async function approveDevice(vaultId: string, userCode: string): Promise<void> {
  await apiFetch<unknown>(`/api/vaults/${vaultId}/devices/approve`, {
    method: "POST",
    body: JSON.stringify({ userCode }),
  });
}

export async function denyDevice(vaultId: string, userCode: string): Promise<void> {
  await apiFetch<unknown>(`/api/vaults/${vaultId}/devices/deny`, {
    method: "POST",
    body: JSON.stringify({ userCode }),
  });
}

export interface Device {
  id: string;
  deviceName: string;
  receiveInternals: boolean;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export async function listDevices(vaultId: string): Promise<Device[]> {
  return apiFetch<Device[]>(`/api/vaults/${vaultId}/devices`);
}

export async function revokeDevice(vaultId: string, deviceId: string): Promise<void> {
  await apiFetch<unknown>(`/api/vaults/${vaultId}/devices/${deviceId}`, {
    method: "DELETE",
  });
}

export async function updateDevice(
  vaultId: string,
  deviceId: string,
  updates: { receiveInternals: boolean }
): Promise<void> {
  await apiFetch<unknown>(`/api/vaults/${vaultId}/devices/${deviceId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

// ── Restore & Export (Slice 13) ───────────────────────────────────────────────

export interface Snapshot {
  hash: string;
  message: string;
  ts: string;
  author: string;
}

/** Returns the sealed commit timeline from Artifacts. Empty if vault not yet sealed. */
export async function listSnapshots(vaultId: string): Promise<Snapshot[]> {
  const res = await apiFetch<{ snapshots: Snapshot[] }>(`/api/vaults/${vaultId}/snapshots`);
  return res.snapshots;
}

/**
 * Restore a file to the provided content (creates a new revision).
 * Returns the updated ManifestEntry.
 */
export async function restoreFile(
  vaultId: string,
  path: string,
  content: string
): Promise<{ restored: boolean; entry: ManifestEntry }> {
  return apiFetch<{ restored: boolean; entry: ManifestEntry }>(
    `/api/vaults/${vaultId}/files/${encodeURIComponent(path)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );
}

/**
 * Returns the URL for downloading the vault's latest content as a zip.
 * Use as an <a href> or trigger programmatic download.
 */
export function exportUrl(vaultId: string): string {
  return `/api/vaults/${vaultId}/export`;
}

// ── Seed (Slice 08) ───────────────────────────────────────────────────────────

export interface SeedCompleteResult {
  ok: boolean;
  commitHash: string;
  fileCount: number;
  remote: string;
}

/**
 * Upload a single file during a vault seed operation.
 * Uses device Bearer auth (the plugin calls this, not the web UI).
 * Exposed here for documentation completeness and testing.
 */
export async function seedFile(
  vaultId: string,
  filePath: string,
  content: ArrayBuffer,
  contentType: string,
  syncToken: string
): Promise<Response> {
  return fetch(`/api/sync/${vaultId}/seed/files/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${syncToken}`,
      "Content-Type": contentType,
    },
    body: content,
  });
}

/**
 * Call after all seed files are uploaded to trigger an immediate Artifacts seal.
 */
export async function completeSeed(
  vaultId: string,
  syncToken: string
): Promise<SeedCompleteResult> {
  const res = await fetch(`/api/sync/${vaultId}/seed/complete`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${syncToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<SeedCompleteResult>;
}
