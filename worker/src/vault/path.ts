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
  if (!path || typeof path !== "string") return false;

  // No leading slash (absolute paths are rejected)
  if (path.startsWith("/")) return false;

  // No control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return false;

  // No empty segments or dot-dot traversal
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }

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

/**
 * Validate path and throw a 400-class error string if invalid.
 * Use this in route handlers before any R2/manifest operations.
 */
export function validateVaultPath(path: string): void {
  if (!isValidVaultPath(path)) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
}
