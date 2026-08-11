/**
 * Per-vault MCP access settings + path allow/deny matching.
 */

export interface VaultMcpSettings {
  vaultId: string;
  enabled: boolean;
  /** When true, write/delete tools are rejected even if allowWrite is set. */
  readOnly: boolean;
  /** Empty = all paths allowed (subject to deny). Prefix or trailing-* glob. */
  allowPaths: string[];
  denyPaths: string[];
  allowWrite: boolean;
  allowSearch: boolean;
  allowDelete: boolean;
  maxReadBytes: number;
  updatedAt: string;
}

export type VaultMcpSettingsPatch = Partial<
  Omit<VaultMcpSettings, "vaultId" | "updatedAt">
>;

const DEFAULT_MAX_READ = 1_048_576;

export function defaultMcpSettings(vaultId: string): VaultMcpSettings {
  return {
    vaultId,
    enabled: false,
    readOnly: false,
    allowPaths: [],
    denyPaths: [".obsidian/", ".trash/", ".sync-conflicts/"],
    allowWrite: true,
    allowSearch: true,
    allowDelete: false,
    maxReadBytes: DEFAULT_MAX_READ,
    updatedAt: new Date(0).toISOString(),
  };
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

type Row = {
  vault_id: string;
  enabled: number;
  read_only: number;
  allow_paths: string;
  deny_paths: string;
  allow_write: number;
  allow_search: number;
  allow_delete: number;
  max_read_bytes: number;
  updated_at: string;
};

function rowToSettings(row: Row): VaultMcpSettings {
  return {
    vaultId: row.vault_id,
    enabled: row.enabled === 1,
    readOnly: row.read_only === 1,
    allowPaths: parseJsonArray(row.allow_paths),
    denyPaths: parseJsonArray(row.deny_paths),
    allowWrite: row.allow_write === 1,
    allowSearch: row.allow_search === 1,
    allowDelete: row.allow_delete === 1,
    maxReadBytes: Number(row.max_read_bytes) || DEFAULT_MAX_READ,
    updatedAt: row.updated_at,
  };
}

export async function getMcpSettings(db: D1Database, vaultId: string): Promise<VaultMcpSettings> {
  const row = await db
    .prepare(
      `SELECT vault_id, enabled, read_only, allow_paths, deny_paths,
              allow_write, allow_search, allow_delete, max_read_bytes, updated_at
       FROM vault_mcp_settings WHERE vault_id = ?`
    )
    .bind(vaultId)
    .first<Row>();
  return row ? rowToSettings(row) : defaultMcpSettings(vaultId);
}

export async function putMcpSettings(
  db: D1Database,
  vaultId: string,
  patch: VaultMcpSettingsPatch
): Promise<VaultMcpSettings> {
  const current = await getMcpSettings(db, vaultId);
  const next: VaultMcpSettings = {
    ...current,
    ...patch,
    vaultId,
    allowPaths: patch.allowPaths ?? current.allowPaths,
    denyPaths: patch.denyPaths ?? current.denyPaths,
    maxReadBytes: Math.max(1024, Math.min(patch.maxReadBytes ?? current.maxReadBytes, 8_388_608)),
    updatedAt: new Date().toISOString(),
  };

  await db
    .prepare(
      `INSERT INTO vault_mcp_settings
       (vault_id, enabled, read_only, allow_paths, deny_paths,
        allow_write, allow_search, allow_delete, max_read_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_id) DO UPDATE SET
         enabled = excluded.enabled,
         read_only = excluded.read_only,
         allow_paths = excluded.allow_paths,
         deny_paths = excluded.deny_paths,
         allow_write = excluded.allow_write,
         allow_search = excluded.allow_search,
         allow_delete = excluded.allow_delete,
         max_read_bytes = excluded.max_read_bytes,
         updated_at = excluded.updated_at`
    )
    .bind(
      vaultId,
      next.enabled ? 1 : 0,
      next.readOnly ? 1 : 0,
      JSON.stringify(next.allowPaths),
      JSON.stringify(next.denyPaths),
      next.allowWrite ? 1 : 0,
      next.allowSearch ? 1 : 0,
      next.allowDelete ? 1 : 0,
      next.maxReadBytes,
      next.updatedAt
    )
    .run();

  return next;
}

/** Normalize to vault-relative path without leading slash. */
export function normalizeVaultPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * Match path against a rule:
 * - `"notes/"` → prefix
 * - `"notes/*"` → prefix `notes/`
 * - `"exact.md"` → exact (case-insensitive)
 */
export function pathMatchesRule(path: string, rule: string): boolean {
  const p = normalizeVaultPath(path).toLowerCase();
  let r = rule.trim().replace(/^\/+/, "").toLowerCase();
  if (!r) return false;
  if (r.endsWith("/*")) r = r.slice(0, -1); // notes/* → notes/
  if (r.endsWith("/")) return p.startsWith(r) || p === r.slice(0, -1);
  return p === r || p.startsWith(`${r}/`);
}

export function isPathAllowed(path: string, settings: VaultMcpSettings): boolean {
  const p = normalizeVaultPath(path);
  for (const deny of settings.denyPaths) {
    if (pathMatchesRule(p, deny)) return false;
  }
  if (settings.allowPaths.length === 0) return true;
  return settings.allowPaths.some((a) => pathMatchesRule(p, a));
}

export function assertPathAccess(path: string, settings: VaultMcpSettings, action: string): void {
  if (!isPathAllowed(path, settings)) {
    throw new Error(`MCP path denied for ${action}: ${path}`);
  }
}
