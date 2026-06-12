export interface LapisSettings {
  serverUrl: string;
  vaultId: string;
  syncToken: string;
  deviceName: string;
  receiveInternals: boolean;
  lastConnectedAt: string | null;
}

export const DEFAULT_SETTINGS: LapisSettings = {
  serverUrl: "http://localhost:8787",
  vaultId: "",
  syncToken: "",
  deviceName: "",
  receiveInternals: false,
  lastConnectedAt: null,
};

export interface DeviceAuthRequest {
  vaultId: string;
  deviceName: string;
}

export interface DeviceAuthChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "approved"; token: string }
  | { status: "denied" | "expired" | "not_found" };

export interface LapisRequestOptions {
  method?: string;
  path: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  token?: string;
}

export interface LapisResponse<T> {
  status: number;
  data: T | null;
  text: string;
}
