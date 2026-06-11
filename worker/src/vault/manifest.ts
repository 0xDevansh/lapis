/**
 * Vault Content Manifest
 *
 * Stored at `_manifest.json` in R2 (within the vault's key prefix).
 * Tracks every visible Vault Content file with its size, content type,
 * last-modified time, and R2 key for retrieval.
 *
 * The manifest enables:
 *   - Folder-tree construction without listing R2 objects
 *   - Case-only duplicate path prevention
 *   - Efficient diffs for sync (Slices 09+)
 */

export interface ManifestEntry {
  /** Vault-relative path, e.g. "notes/hello.md" */
  path: string;
  /** R2 object key (vault-prefixed), e.g. "<vaultId>/notes/hello.md" */
  r2Key: string;
  /** Size in bytes */
  size: number;
  /** MIME type */
  contentType: string;
  /** ISO timestamp of last accepted revision */
  updatedAt: string;
  /**
   * Monotonic revision counter for this file.
   * Incremented on every accepted write (web or plugin).
   * Used by the sync protocol to detect staleness.
   * 0 or undefined for entries created before Slice 09.
   */
  revision: number;
}

export interface VaultManifest {
  /** Vault ID this manifest belongs to */
  vaultId: string;
  /** ISO timestamp of last manifest write */
  updatedAt: string;
  /** Map from lower-cased path → ManifestEntry (canonical casing stored in entry.path) */
  entries: Record<string, ManifestEntry>;
}

/** Return an empty manifest for a new vault. */
export function emptyManifest(vaultId: string): VaultManifest {
  return {
    vaultId,
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

/**
 * Check if adding `path` to `manifest` would create a case-only duplicate.
 * `existingPath` is the currently-stored path to exclude from the check
 * (use when updating an existing entry).
 */
export function hasCaseDuplicate(
  manifest: VaultManifest,
  path: string,
  existingPath?: string
): boolean {
  const lower = path.toLowerCase();
  const current = manifest.entries[lower];
  if (!current) return false;
  if (existingPath && current.path === existingPath) return false;
  // There is already an entry at this lowercase key, and it's not the one we're updating
  return current.path !== path;
}

/** R2 key for the manifest object within a vault's prefix. */
export function manifestKey(vaultId: string): string {
  return `${vaultId}/_manifest.json`;
}

/** R2 key for a vault content file. */
export function contentKey(vaultId: string, path: string): string {
  return `${vaultId}/${path}`;
}

/**
 * Return true if `path` would be an ancestor of `descendant`.
 * Used to prevent a folder rename that would overwrite its own children.
 */
export function isAncestorPath(ancestor: string, descendant: string): boolean {
  return (
    descendant.toLowerCase().startsWith(ancestor.toLowerCase() + "/")
  );
}
