import type { DeviceTokenResponse } from "../types";

export type TokenFetcher = (deviceCode: string) => Promise<DeviceTokenResponse>;

export interface PollDeviceTokenOptions {
  deviceCode: string;
  fetchToken: TokenFetcher;
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function pollDeviceToken(options: PollDeviceTokenOptions): Promise<{ token: string; deviceId: string }> {
  const intervalMs = options.intervalMs ?? 3000;

  while (!options.signal?.aborted) {
    const result = await options.fetchToken(options.deviceCode);
    if (result.status === "approved") {
      return { token: result.token, deviceId: result.deviceId };
    }
    if (result.status === "denied") {
      throw new Error("Connection denied");
    }
    if (result.status === "expired") {
      throw new Error("Connection expired");
    }
    if (result.status === "not_found") {
      throw new Error("Connection request not found");
    }

    await wait(intervalMs, options.signal);
  }

  throw new Error("Connection cancelled");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Connection cancelled"));
      return;
    }

    const timeout = window.setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("Connection cancelled"));
      },
      { once: true }
    );
  });
}
