/**
 * Vault path validation utilities.
 *
 * A valid vault content path must:
 *   - Be a non-empty relative path using forward slashes
 *   - Not contain control characters (U+0000–U+001F, U+007F)
 *   - Not traverse above root (no `..` segments)
 *   - Not be an absolute path (no leading `/`)
 *   - Not be `.obsidian/` or other vault-internal directories
 *     (exception: `.sync-conflicts/` IS allowed as visible Vault Content)
 *
 * Case-only duplicate prevention is enforced by the manifest, not here.
 */

/** Vault-internal prefixes that are hidden from Vault Content. */
const HIDDEN_PREFIXES = [
  ".obsidian/",
  ".obsidian",
  ".trash/",
  ".trash",
];

/** Reserved sync-internal prefixes that must not be written to directly. */
const RESERVED_PREFIXES = [
  "_manifest.json", // internal manifest file
];

/**
 * Return true if `path` is a valid Vault Content path.
 * Does NOT check for case duplicates — that is the manifest's job.
 */
export function isValidVaultPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;

  // Block vault internals (but allow .sync-conflicts/)
  const lower = path.toLowerCase();
  for (const prefix of HIDDEN_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix)) return false;
  }

  // Block internal reserved names
  for (const reserved of RESERVED_PREFIXES) {
    if (lower === reserved) return false;
  }

  return true;
}

/**
 * Device sync may opt into hidden Vault Internals, but never reserved
 * server-owned names such as `_manifest.json`.
 */
export function isValidSyncPath(path: string, allowInternals: boolean): boolean {
  if (isValidVaultPath(path)) return true;
  if (!allowInternals || !isSafeRelativePath(path) || !isVaultInternal(path)) {
    return false;
  }
  const lower = path.toLowerCase();
  return !RESERVED_PREFIXES.some((reserved) => lower === reserved);
}

/**
 * Return true if `path` is under a vault-internal directory that should be
 * hidden from Vault Content browsing.
 */
export function isVaultInternal(path: string): boolean {
  const lower = path.toLowerCase();
  for (const prefix of HIDDEN_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix)) return true;
  }
  return false;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || typeof path !== "string" || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Validate path and throw a 400-class error string if invalid.
 * Use this in route handlers before any R2/manifest operations.
 */
export function validateVaultPath(path: string): void {
  if (!isValidVaultPath(path)) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
}

/**
 * OS junk / cache file names that should be silently ignored when
 * accepting files through sync or import paths.
 */
const OS_JUNK_NAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  ".localized",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  ".documentrevisions-v100",
  ".temporaryitems",
]);

const OS_JUNK_EXTENSIONS = new Set([".crdownload", ".part", ".tmp", ".swp", ".swo"]);

/**
 * Return true if the file at `path` should be silently dropped rather than
 * stored as Vault Content. Checked on sync/import paths, not user-initiated writes.
 */
export function isOsJunk(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;

  if (OS_JUNK_NAMES.has(name)) return true;
  if (name.startsWith("._")) return true; // macOS resource fork shadows

  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = name.slice(dotIdx);
    if (OS_JUNK_EXTENSIONS.has(ext)) return true;
  }

  return false;
}
