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
      const body = await res.json() as { error?: string; message?: string };
      if (body.error || body.message) message = body.error ?? body.message!;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  // better-auth may return an empty body for some endpoints; treat as null.
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthCredentialResponse {
  user: User;
}

export async function signUp(name: string, email: string, password: string): Promise<User> {
  const res = await apiFetch<AuthCredentialResponse>("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
  return res.user;
}

export async function signIn(email: string, password: string): Promise<User> {
  const res = await apiFetch<AuthCredentialResponse>("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return res.user;
}

export async function signOut(): Promise<void> {
  // better-auth rejects Content-Type: application/json with an empty body
  // ("Invalid JSON in request body"). Send an empty JSON object.
  await apiFetch<unknown>("/api/auth/sign-out", {
    method: "POST",
    body: "{}",
  });
}

export interface SessionInfo {
  user: User;
  session?: {
    id: string;
  };
}

export async function getSession(): Promise<SessionInfo | null> {
  try {
    return await apiFetch<SessionInfo>("/api/auth/get-session");
  } catch {
    return null;
  }
}

// ── Vaults ────────────────────────────────────────────────────────────────────

export interface Vault {
  id: string;
  name: string;
  createdAt: string;
  role?: "owner" | "editor" | "viewer";
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
  /** Monotonic stub kept for FolderTree compatibility; CRDT has no revision. */
  revision: number;
}

export interface VaultManifest {
  vaultId: string;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

/** Derived listing from server Y.Doc (prefer client Yjs when connected). */
export async function getManifest(vaultId: string): Promise<VaultManifest> {
  return apiFetch<VaultManifest>(`/api/vaults/${vaultId}/manifest`);
}

/** Fetch file bytes as text (binaries / fallback; prefer Yjs for notes). */
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

/** Upload a binary file (R2 + Yjs meta). Text notes should use the Yjs provider. */
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
  kind?: string;
  receiveInternals: boolean;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  conflictPolicy?: string;
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

// ── MCP (vault agent tools) ───────────────────────────────────────────────────

export interface VaultMcpSettings {
  vaultId: string;
  enabled: boolean;
  readOnly: boolean;
  allowPaths: string[];
  denyPaths: string[];
  allowWrite: boolean;
  allowSearch: boolean;
  allowDelete: boolean;
  maxReadBytes: number;
  updatedAt: string;
  endpoint: string;
}

export async function getMcpSettings(vaultId: string): Promise<VaultMcpSettings> {
  return apiFetch<VaultMcpSettings>(`/api/vaults/${vaultId}/mcp`);
}

export async function updateMcpSettings(
  vaultId: string,
  patch: Partial<
    Pick<
      VaultMcpSettings,
      | "enabled"
      | "readOnly"
      | "allowPaths"
      | "denyPaths"
      | "allowWrite"
      | "allowSearch"
      | "allowDelete"
      | "maxReadBytes"
    >
  >
): Promise<VaultMcpSettings> {
  return apiFetch<VaultMcpSettings>(`/api/vaults/${vaultId}/mcp`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function createMcpToken(
  vaultId: string,
  name: string
): Promise<{ tokenId: string; name: string; token: string; endpoint: string }> {
  return apiFetch(`/api/vaults/${vaultId}/mcp/tokens`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ── GitHub remote sync (Slices 25–26) ─────────────────────────────────────────

export type GitRemoteSyncState = "idle" | "pulling" | "pushing" | "conflict";

export interface GitRemoteMeta {
  provider: string;
  repoUrl: string;
  branch: string;
  subdir: string | null;
  patLast4: string | null;
  lastSyncedCommit: string | null;
  lastSyncedAt: string | null;
  syncState: GitRemoteSyncState;
}

export interface GitRemoteStatus {
  connected: boolean;
  provider?: string;
  repoUrl?: string;
  branch?: string;
  subdir?: string | null;
  patLast4?: string | null;
  lastSyncedCommit?: string | null;
  lastSyncedAt?: string | null;
  syncState?: GitRemoteSyncState;
}

export async function getGitRemote(vaultId: string): Promise<GitRemoteStatus> {
  return apiFetch<GitRemoteStatus>(`/api/vaults/${vaultId}/git-remote`);
}

export async function connectGitRemote(
  vaultId: string,
  input: { repoUrl: string; branch?: string; subdir?: string; pat: string }
): Promise<GitRemoteMeta> {
  return apiFetch<GitRemoteMeta>(`/api/vaults/${vaultId}/git-remote`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function disconnectGitRemote(vaultId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/vaults/${vaultId}/git-remote`, {
    method: "DELETE",
  });
}

export async function pushGitRemote(
  vaultId: string
): Promise<{ ok: boolean; commitHash?: string; fileCount?: number; remote?: string }> {
  return apiFetch(`/api/vaults/${vaultId}/git-remote/push`, { method: "POST" });
}

// ── Restore & Export (Slice 13) ───────────────────────────────────────────────

export interface Snapshot {
  hash: string;
  message: string;
  ts: string;
  author: string;
}

/** Returns the GitHub commit timeline. Empty if no remote is connected. */
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
