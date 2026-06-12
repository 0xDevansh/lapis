/**
 * Artifacts sealer — Slice 04
 *
 * Seals the current vault snapshot into an Artifacts Git repository as a
 * single commit. Called from the VaultCoordinator alarm handler after a
 * 2–10 second debounce following the last accepted file write.
 *
 * Architecture:
 *   - One Artifacts repo per vault, named `vault-<vaultId>`.
 *   - Commits are server-created only; Artifacts tokens are never returned
 *     to web clients or plugin devices.
 *   - Each seal reads vault content from R2 (the live read model) and pushes
 *     the full current tree as a new commit on `main`.
 *   - The seal is fire-and-forget from the mutation path; failures are logged
 *     via Workers Observability and do not corrupt R2 state.
 *
 * Workers binding surface (as of wrangler 4.x):
 *   Artifacts (namespace): create, get, import, list, delete
 *   ArtifactsRepo (handle): createToken, listTokens, revokeToken, fork
 *
 * Reading git history (log, commit trees) is done by cloning into MemoryFS
 * with a short-lived read token, then using isomorphic-git locally.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import type { VaultManifest } from "../vault/manifest";

export interface SealResult {
  commitHash: string;
  repoName: string;
  remote: string;
  fileCount: number;
}

export interface SealedCommit {
  hash: string;
  message: string;
  ts: string;
  author: string;
}

/** Artifacts repo name for a vault. Must start with a letter per naming rules. */
export function repoName(vaultId: string): string {
  return `vault-${vaultId}`;
}

/**
 * Ensure the Artifacts repo for this vault exists.
 * Returns the repo's HTTPS remote URL and a fresh short-lived write token secret.
 *
 * On first call (existingRemote is null): creates the repo.
 * On subsequent calls: mints a new 10-minute write token against the existing repo.
 */
export async function ensureRepoAndToken(
  artifacts: Artifacts,
  vaultId: string,
  existingRemote: string | null
): Promise<{ remote: string; tokenSecret: string }> {
  const name = repoName(vaultId);

  if (existingRemote) {
    // Repo already exists — mint a fresh 10-minute write token
    const repo = await artifacts.get(name);
    const result = await repo.createToken("write", 600);
    // plaintext format: "art_v1_<secret>?expires=<unix>"
    const tokenSecret = result.plaintext.split("?expires=")[0];
    return { remote: existingRemote, tokenSecret };
  }

  // First seal — try to create the repo
  try {
    const created = await artifacts.create(name, {
      description: `Lapis vault ${vaultId} sealed history`,
      setDefaultBranch: "main",
    });
    const tokenSecret = created.token.split("?expires=")[0];
    return { remote: created.remote, tokenSecret };
  } catch (err: unknown) {
    // If repo already exists, mint a write token instead. The Artifacts binding
    // does not consistently expose a structured error code in local dev.
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    const isAlreadyExists =
      err instanceof Error &&
      ((err as Error & { code?: string }).code === "ALREADY_EXISTS" || message.includes("repo already exists") || message.includes("already exists"));

    if (!isAlreadyExists) throw err;

    const repo = await artifacts.get(name);
    const result = await repo.createToken("write", 600);
    const tokenSecret = result.plaintext.split("?expires=")[0];

    // Retrieve remote from list() — ArtifactsRepoListResult.repos omits `remote`
    // per the type definition, so we cast to access it (it IS present at runtime).
    const page = await artifacts.list({ limit: 200 });
    const found = (page.repos as Array<{ name: string; remote?: string }>)
      .find(r => r.name === name);
    if (!found?.remote) {
      throw new Error(`Cannot determine remote URL for Artifacts repo ${name}`);
    }
    return { remote: found.remote, tokenSecret };
  }
}

/**
 * Seal the current vault snapshot to Artifacts.
 *
 * @param artifacts      ARTIFACTS binding from env
 * @param vaultId        vault identifier
 * @param manifest       current vault manifest
 * @param existingRemote cached repo remote URL (null on first seal)
 * @param readFile       async function to fetch file bytes from R2 by vault path
 * @param label          optional commit message suffix
 * @returns SealResult including remote URL (persist this for subsequent seals)
 */
export async function sealVault(
  artifacts: Artifacts,
  vaultId: string,
  manifest: VaultManifest,
  existingRemote: string | null,
  readFile: (path: string) => Promise<ArrayBuffer | null>,
  label?: string
): Promise<SealResult & { remote: string }> {
  const { remote, tokenSecret } = await ensureRepoAndToken(artifacts, vaultId, existingRemote);

  const dir = "/vault";
  const fs = new MemoryFS();
  await git.init({ fs, dir, defaultBranch: "main" });

  const entries = Object.values(manifest.entries);
  let fileCount = 0;

  // Write current vault content into the in-memory working tree
  for (const entry of entries) {
    const content = await readFile(entry.path);
    if (content === null) continue;
    await fs.promises.writeFile(`${dir}/${entry.path}`, new Uint8Array(content));
    fileCount++;
  }

  // Stage all written files
  for (const entry of entries) {
    try {
      await git.add({ fs, dir, filepath: entry.path });
    } catch {
      // Skip files that failed to write above
    }
  }

  const now = new Date();
  const commitMessage = label
    ? `seal: ${label} (${now.toISOString()})`
    : `seal: snapshot ${now.toISOString()}`;

  const commitHash = await git.commit({
    fs,
    dir,
    message: commitMessage,
    author: {
      name: "Lapis",
      email: "lapis@seal",
      timestamp: Math.floor(now.getTime() / 1000),
      timezoneOffset: 0,
    },
  });

  // Force push — handles both first push to an empty repo and incremental updates
  await git.push({
    fs,
    http,
    dir,
    url: remote,
    ref: "main",
    force: true,
    onAuth: () => ({ username: "x", password: tokenSecret }),
  });

  return { commitHash, repoName: repoName(vaultId), remote, fileCount };
}

/**
 * Read the sealed commit log for a vault.
 * Clones the repo (shallow) into MemoryFS with a read token, then reads
 * the local git log. Returns commits newest-first.
 */
export async function getVaultLog(
  artifacts: Artifacts,
  vaultId: string,
  existingRemote: string | null,
  limit = 50
): Promise<SealedCommit[]> {
  if (!existingRemote) return [];

  const name = repoName(vaultId);
  let tokenSecret: string;
  try {
    const repo = await artifacts.get(name);
    const result = await repo.createToken("read", 300); // 5 min read token
    tokenSecret = result.plaintext.split("?expires=")[0];
  } catch {
    // Repo doesn't exist yet
    return [];
  }

  const dir = "/log";
  const fs = new MemoryFS();

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: existingRemote,
      ref: "main",
      singleBranch: true,
      depth: limit,
      noCheckout: true, // skip working tree checkout — we only need history
      onAuth: () => ({ username: "x", password: tokenSecret }),
    });

    const commits = await git.log({ fs, dir, ref: "main", depth: limit });
    return commits.map(c => ({
      hash: c.oid,
      message: c.commit.message.trim(),
      ts: new Date(c.commit.author.timestamp * 1000).toISOString(),
      author: c.commit.author.name,
    }));
  } catch {
    return [];
  }
}

/**
 * Read a specific file's content at a sealed commit.
 * Clones the repo at the specific commit ref into MemoryFS and reads the file.
 * Returns null if the file doesn't exist at that commit or clone fails.
 */
export async function readFileAtCommit(
  artifacts: Artifacts,
  vaultId: string,
  commitHash: string,
  filePath: string,
  remote: string
): Promise<Uint8Array | null> {
  const name = repoName(vaultId);
  let tokenSecret: string;
  try {
    const repo = await artifacts.get(name);
    const result = await repo.createToken("read", 300);
    tokenSecret = result.plaintext.split("?expires=")[0];
  } catch {
    return null;
  }

  const dir = "/restore";
  const fs = new MemoryFS();

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote,
      ref: commitHash,
      singleBranch: true,
      depth: 1,
      noCheckout: false,
      onAuth: () => ({ username: "x", password: tokenSecret }),
    });

    const content = await fs.promises.readFile(`${dir}/${filePath}`);
    if (content instanceof Uint8Array) return content;
    return new TextEncoder().encode(content as string);
  } catch {
    return null;
  }
}
