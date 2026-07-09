/**
 * GitRemote abstraction — Slices 25–26.
 */

export interface GitAuth {
  username: string;
  password: string;
}

export interface GitRemote {
  readonly provider: string;
  readonly url: string;
  readonly branch: string;
  readonly subdir?: string;
  onAuth(): GitAuth;
}

export function vaultPathFromGit(subdir: string | undefined, gitPath: string): string {
  if (!subdir) return gitPath;
  const prefix = subdir.endsWith("/") ? subdir : `${subdir}/`;
  if (!gitPath.startsWith(prefix)) return "";
  return gitPath.slice(prefix.length);
}

export function gitPathFromVault(subdir: string | undefined, vaultPath: string): string {
  if (!subdir) return vaultPath;
  const prefix = subdir.endsWith("/") ? subdir : `${subdir}/`;
  return `${prefix}${vaultPath}`;
}
