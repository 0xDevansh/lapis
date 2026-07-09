/**
 * Parse and format Lapis vault URLs for one-field plugin connection.
 *
 * Accepts a full browser URL (e.g. https://lapis.example.com/vault/abc-123)
 * or a bare vault ID when a server URL is already known.
 */

export interface ParsedVaultLink {
  serverUrl: string;
  vaultId: string;
}

/** Build the vault link shown in the web app address bar. */
export function formatVaultLink(serverUrl: string, vaultId: string): string {
  const base = serverUrl.replace(/\/$/, "");
  return `${base}/vault/${encodeURIComponent(vaultId)}`;
}

/** Hostname for display, e.g. "lapis.example.com". */
export function serverHostname(serverUrl: string): string {
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl.replace(/^https?:\/\//, "").split("/")[0] || serverUrl;
  }
}

/** Short vault id for status lines. */
export function shortVaultId(vaultId: string): string {
  if (vaultId.length <= 12) return vaultId;
  return `${vaultId.slice(0, 8)}…`;
}

/**
 * Parse user input into server URL + vault ID.
 * Returns null when the input cannot be resolved.
 */
export function parseVaultLink(input: string, fallbackServerUrl = ""): ParsedVaultLink | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/^\/vault\/([^/]+)/);
      if (!match) return null;
      return {
        serverUrl: url.origin,
        vaultId: decodeURIComponent(match[1]),
      };
    } catch {
      return null;
    }
  }

  const bareId = trimmed.replace(/^\/+|\/+$/g, "");
  if (!bareId) return null;

  const fallback = fallbackServerUrl.trim().replace(/\/$/, "");
  if (fallback) {
    return { serverUrl: fallback, vaultId: bareId };
  }

  return null;
}

/** Apply parsed link fields onto settings; returns false if input is invalid. */
export function applyVaultLinkToSettings(
  settings: { serverUrl: string; vaultId: string },
  input: string
): boolean {
  const parsed = parseVaultLink(input, settings.serverUrl);
  if (!parsed) return false;
  settings.serverUrl = parsed.serverUrl;
  settings.vaultId = parsed.vaultId;
  return true;
}

/** Best-effort display value for the vault link field. */
export function vaultLinkDisplay(settings: { serverUrl: string; vaultId: string }): string {
  if (settings.serverUrl && settings.vaultId) {
    return formatVaultLink(settings.serverUrl, settings.vaultId);
  }
  return settings.vaultId || settings.serverUrl || "";
}
