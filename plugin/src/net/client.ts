import { requestUrl } from "obsidian";
import type {
  DeviceAuthChallenge,
  DeviceAuthRequest,
  DeviceTokenResponse,
  LapisRequestOptions,
  LapisResponse,
  ManifestEntry,
  BatchSyncResponse,
  PatchResponse,
  StaleWriteResponse,
  SeedCompleteResult,
  VaultManifest,
} from "../types";

export class StaleWriteError extends Error {
  constructor(message: string, readonly headRevision: number) {
    super(message);
    this.name = "StaleWriteError";
  }
}

export class LapisClient {
  constructor(private readonly serverUrl: string) {}

  async request<T>(options: LapisRequestOptions): Promise<LapisResponse<T>> {
    const headers: Record<string, string> = {};
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    Object.assign(headers, options.headers);

    const response = await requestUrl({
      url: this.url(options.path),
      method: options.method ?? "GET",
      body: options.body,
      contentType: options.contentType,
      headers,
      throw: false,
    });

    let data: T | null = null;
    if (response.text.length > 0) {
      try {
        data = JSON.parse(response.text) as T;
      } catch {
        data = null;
      }
    }

    return { status: response.status, data, text: response.text };
  }

  async requestDeviceCode(input: DeviceAuthRequest): Promise<DeviceAuthChallenge> {
    const response = await this.request<DeviceAuthChallenge>({
      method: "POST",
      path: "/api/device-auth/request",
      body: JSON.stringify(input),
      contentType: "application/json",
    });

    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Device auth request failed (${response.status})`);
    }

    return response.data;
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse> {
    const response = await this.request<{ token?: string; deviceId?: string; status?: string; error?: string }>({
      method: "POST",
      path: "/api/device-auth/token",
      body: JSON.stringify({ deviceCode }),
      contentType: "application/json",
    });

    if (response.status === 202) {
      return { status: "pending" };
    }
    if (response.status === 200 && response.data?.token) {
      return { status: "approved", token: response.data.token, deviceId: response.data.deviceId ?? "" };
    }

    const error = response.data?.error;
    if (error === "denied" || error === "expired" || error === "not_found") {
      return { status: error };
    }

    throw new Error(response.text || `Device token poll failed (${response.status})`);
  }

  async getManifest(vaultId: string, token: string): Promise<VaultManifest> {
    const response = await this.request<VaultManifest>({
      path: `/api/sync/${encodeURIComponent(vaultId)}/manifest`,
      token,
    });
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Manifest request failed (${response.status})`);
    }
    return response.data;
  }

  async getFile(vaultId: string, path: string, token: string): Promise<ArrayBuffer> {
    const response = await requestUrl({
      url: this.url(`/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(path)}`),
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (response.status !== 200) {
      throw new Error(response.text || `File request failed (${response.status})`);
    }
    return response.arrayBuffer;
  }

  async seedFile(vaultId: string, path: string, content: ArrayBuffer, contentType: string, token: string): Promise<ManifestEntry | null> {
    const response = await this.request<ManifestEntry>({
      method: "PUT",
      path: `/api/sync/${encodeURIComponent(vaultId)}/seed/files/${encodePath(path)}`,
      body: content,
      contentType,
      token,
    });
    if (response.status === 204) {
      return null;
    }
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Seed upload failed (${response.status})`);
    }
    return response.data;
  }

  async completeSeed(vaultId: string, token: string): Promise<SeedCompleteResult> {
    const response = await this.request<SeedCompleteResult>({
      method: "POST",
      path: `/api/sync/${encodeURIComponent(vaultId)}/seed/complete`,
      body: JSON.stringify({}),
      contentType: "application/json",
      token,
    });
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Seed completion failed (${response.status})`);
    }
    return response.data;
  }

  async putFile(vaultId: string, path: string, content: ArrayBuffer, contentType: string, token: string): Promise<ManifestEntry> {
    const response = await this.request<ManifestEntry>({
      method: "PUT",
      path: `/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(path)}`,
      body: content,
      contentType,
      token,
    });
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `File upload failed (${response.status})`);
    }
    return response.data;
  }

  async putFileWithBaseRevision(
    vaultId: string,
    path: string,
    content: ArrayBuffer,
    contentType: string,
    baseRevision: number,
    token: string
  ): Promise<ManifestEntry> {
    const response = await this.request<ManifestEntry | StaleWriteResponse>({
      method: "PUT",
      path: `/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(path)}`,
      body: content,
      contentType,
      token,
      headers: { "X-Base-Revision": String(baseRevision) },
    });
    if (response.status === 200 && isManifestEntry(response.data)) {
      return response.data;
    }
    if (response.status === 409) {
      throw staleWriteError(staleBody(response.data), response.text);
    }
    throw new Error(response.text || `File upload failed (${response.status})`);
  }

  async applyPatch(
    vaultId: string,
    path: string,
    patch: string,
    baseRevision: number,
    token: string
  ): Promise<ManifestEntry> {
    const response = await this.request<ManifestEntry | PatchResponse | StaleWriteResponse>({
      method: "POST",
      path: `/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(path)}/patch`,
      body: JSON.stringify({ patch, baseRevision }),
      contentType: "application/json",
      token,
    });
    if (response.status === 200 && response.data) {
      if ("entry" in response.data) {
        return response.data.entry;
      }
      if (!isManifestEntry(response.data)) {
        throw new Error(response.text || "Invalid patch response");
      }
      return response.data;
    }
    if (response.status === 409) {
      throw staleWriteError(staleBody(response.data), response.text);
    }
    throw new Error(response.text || `Patch failed (${response.status})`);
  }

  async renameFile(vaultId: string, oldPath: string, newPath: string, token: string): Promise<ManifestEntry> {
    const response = await this.request<ManifestEntry>({
      method: "PATCH",
      path: `/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(oldPath)}`,
      body: JSON.stringify({ newPath }),
      contentType: "application/json",
      token,
    });
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Rename failed (${response.status})`);
    }
    return response.data;
  }

  async deleteFile(vaultId: string, path: string, token: string): Promise<void> {
    const response = await this.request<{ ok: boolean }>({
      method: "DELETE",
      path: `/api/sync/${encodeURIComponent(vaultId)}/files/${encodePath(path)}`,
      token,
    });
    if (response.status !== 200) {
      throw new Error(response.text || `Delete failed (${response.status})`);
    }
  }

  async batchSync(vaultId: string, ops: unknown[], token: string): Promise<BatchSyncResponse> {
    const response = await this.request<BatchSyncResponse>({
      method: "POST",
      path: `/api/sync/${encodeURIComponent(vaultId)}/batch`,
      body: JSON.stringify({ ops }),
      contentType: "application/json",
      token,
    });
    if (response.status !== 200 || !response.data) {
      throw new Error(response.text || `Batch sync failed (${response.status})`);
    }
    return response.data;
  }

  async updateDevice(vaultId: string, token: string, receiveInternals: boolean): Promise<void> {
    const response = await this.request<{ ok: boolean }>({
      method: "PATCH",
      path: `/api/sync/${encodeURIComponent(vaultId)}/device`,
      body: JSON.stringify({ receiveInternals }),
      contentType: "application/json",
      token,
    });
    if (response.status !== 200) {
      throw new Error(response.text || `Device update failed (${response.status})`);
    }
  }

  private url(path: string): string {
    return `${this.serverUrl.replace(/\/$/, "")}${path}`;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function staleWriteError(data: StaleWriteResponse | null, fallback: string): StaleWriteError {
  const headRevision = data?.headRevision ?? data?.serverRevision;
  if (typeof headRevision === "number") {
    return new StaleWriteError(data?.error ?? "Revision conflict", headRevision);
  }
  return new StaleWriteError(fallback || "Revision conflict", -1);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return typeof value === "object" && value !== null && typeof (value as ManifestEntry).path === "string" && typeof (value as ManifestEntry).revision === "number";
}

function staleBody(value: unknown): StaleWriteResponse | null {
  return typeof value === "object" && value !== null ? (value as StaleWriteResponse) : null;
}
