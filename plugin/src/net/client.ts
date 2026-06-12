import { requestUrl } from "obsidian";
import type { DeviceAuthChallenge, DeviceAuthRequest, DeviceTokenResponse, LapisRequestOptions, LapisResponse } from "../types";

export class LapisClient {
  constructor(private readonly serverUrl: string) {}

  async request<T>(options: LapisRequestOptions): Promise<LapisResponse<T>> {
    const headers: Record<string, string> = {};
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

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
    const response = await this.request<{ token?: string; status?: string; error?: string }>({
      method: "POST",
      path: "/api/device-auth/token",
      body: JSON.stringify({ deviceCode }),
      contentType: "application/json",
    });

    if (response.status === 202) {
      return { status: "pending" };
    }
    if (response.status === 200 && response.data?.token) {
      return { status: "approved", token: response.data.token };
    }

    const error = response.data?.error;
    if (error === "denied" || error === "expired" || error === "not_found") {
      return { status: error };
    }

    throw new Error(response.text || `Device token poll failed (${response.status})`);
  }

  private url(path: string): string {
    return `${this.serverUrl.replace(/\/$/, "")}${path}`;
  }
}
