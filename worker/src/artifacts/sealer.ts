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
import type { GitRemote } from "../git/remote";
import { gitPathFromVault } from "../git/remote";
export interface SealResult {
  commitHash: string;
  repoName: string;
  remote: string;
  fileCount: number;
}

export interface IncrementalSealChange {
  path: string;
  deleted?: boolean;
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
 * Seal vault changes to any GitRemote (Artifacts or GitHub).
 */
export async function sealToRemote(
  remote: GitRemote,
  vaultId: string,
  changes: IncrementalSealChange[],
  readFile: (path: string) => Promise<ArrayBuffer | null>,
  label?: string,
  commitAuthor = "Lapis"
): Promise<SealResult & { remote: string }> {
  const dir = "/vault";
  const fs = new MemoryFS();
  const auth = remote.onAuth();

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote.url,
      ref: remote.branch,
      singleBranch: true,
      depth: 1,
      noCheckout: false,
      onAuth: () => auth,
    });
  } catch {
    await git.init({ fs, dir, defaultBranch: remote.branch });
  }

  let fileCount = 0;
  for (const change of changes) {
    const gitPath = gitPathFromVault(remote.subdir, change.path);
    if (!gitPath) continue;

    if (change.deleted) {
      try {
        await git.remove({ fs, dir, filepath: gitPath });
        fileCount++;
      } catch {
        // idempotent delete
      }
      continue;
    }

    const content = await readFile(change.path);
    if (content === null) continue;
    await fs.promises.writeFile(`${dir}/${gitPath}`, new Uint8Array(content));
    await git.add({ fs, dir, filepath: gitPath });
    fileCount++;
  }

  if (fileCount === 0) {
    return { commitHash: "", repoName: repoName(vaultId), remote: remote.url, fileCount };
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
      name: commitAuthor,
      email: "lapis@seal",
      timestamp: Math.floor(now.getTime() / 1000),
      timezoneOffset: 0,
    },
  });

  try {
    await git.push({
      fs,
      http,
      dir,
      url: remote.url,
      ref: remote.branch,
      onAuth: () => auth,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("not a fast-forward") || message.includes("non-fast-forward")) {
      throw Object.assign(new Error("Push rejected: non-fast-forward"), { code: "NON_FAST_FORWARD" });
    }
    throw err;
  }

  return { commitHash, repoName: repoName(vaultId), remote: remote.url, fileCount };
}

/**
 * Seal the current vault snapshot to Artifacts (legacy wrapper).
 */
export async function sealVault(
  artifacts: Artifacts,
  vaultId: string,
  changes: IncrementalSealChange[],
  existingRemote: string | null,
  readFile: (path: string) => Promise<ArrayBuffer | null>,
  label?: string
): Promise<SealResult & { remote: string }> {
  const { remote, tokenSecret } = await ensureRepoAndToken(artifacts, vaultId, existingRemote);
  const artifactsRemote: GitRemote = {
    provider: "artifacts",
    url: remote,
    branch: "main",
    onAuth: () => ({ username: "x", password: tokenSecret }),
  };
  return sealToRemote(artifactsRemote, vaultId, changes, readFile, label);
}

export async function getRemoteLog(remote: GitRemote, limit = 50): Promise<SealedCommit[]> {
  const dir = "/log";
  const fs = new MemoryFS();
  const auth = remote.onAuth();

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote.url,
      ref: remote.branch,
      singleBranch: true,
      depth: limit,
      noCheckout: true,
      onAuth: () => auth,
    });

    const commits = await git.log({ fs, dir, ref: remote.branch, depth: limit });
    return commits.map((c) => ({
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
 * Read the sealed commit log for a vault (Artifacts wrapper).
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

export async function readFileAtRemoteCommit(
  remote: GitRemote,
  commitHash: string,
  filePath: string
): Promise<Uint8Array | null> {
  const dir = "/restore";
  const fs = new MemoryFS();
  const auth = remote.onAuth();
  const gitPath = gitPathFromVault(remote.subdir, filePath);

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote.url,
      ref: commitHash,
      singleBranch: true,
      depth: 1,
      noCheckout: false,
      onAuth: () => auth,
    });

    const content = await fs.promises.readFile(`${dir}/${gitPath}`);
    if (content instanceof Uint8Array) return content;
    return new TextEncoder().encode(content as string);
  } catch {
    return null;
  }
}

/**
 * Read a specific file's content at a sealed commit (Artifacts wrapper).
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
