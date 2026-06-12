const OS_JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const OS_JUNK_SUFFIXES = [".crdownload", ".part", ".tmp", ".swp", ".swo"];

export function isValidVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "..");
}

export function isVaultInternal(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === "_manifest.json" || normalized.startsWith(".obsidian/") || normalized.startsWith(".trash/");
}

export function isOsJunk(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (OS_JUNK_NAMES.has(name) || name.startsWith("._")) {
    return true;
  }
  return OS_JUNK_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function shouldSyncPath(path: string, includeInternals: boolean): boolean {
  if (!isValidVaultPath(path) || isOsJunk(path)) {
    return false;
  }
  return includeInternals || !isVaultInternal(path);
}

export function lowerPath(path: string): string {
  return path.toLowerCase();
}
