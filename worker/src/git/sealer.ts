/**
 * GitHub seal helpers — push dirty vault changes to the configured Git remote.
 * History lives on GitHub only (Cloudflare Artifacts removed).
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import type { GitRemote } from "./remote";
import { gitPathFromVault } from "./remote";

export interface SealResult {
  commitHash: string;
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

/**
 * Seal vault changes to a GitRemote (GitHub).
 */
export async function sealToRemote(
  remote: GitRemote,
  _vaultId: string,
  changes: IncrementalSealChange[],
  readFile: (path: string) => Promise<ArrayBuffer | null>,
  label?: string,
  commitAuthor = "Lapis"
): Promise<SealResult> {
  const dir = "/vault";
  const fs = new MemoryFS();
  const auth = remote.onAuth();
  let freshRepo = false;

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
    await git.addRemote({ fs, dir, remote: "origin", url: remote.url });
    // Ensure HEAD points at the configured branch for the first commit/push.
    await git.branch({ fs, dir, ref: remote.branch, checkout: true }).catch(async () => {
      await fs.promises.writeFile(`${dir}/.git/HEAD`, `ref: refs/heads/${remote.branch}\n`);
    });
    freshRepo = true;
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
    return { commitHash: "", remote: remote.url, fileCount: 0 };
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
      remote: "origin",
      ref: remote.branch,
      onAuth: () => auth,
      ...(freshRepo ? { force: true } : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("not a fast-forward") || message.includes("non-fast-forward")) {
      throw Object.assign(new Error("Push rejected: non-fast-forward"), { code: "NON_FAST_FORWARD" });
    }
    throw err;
  }

  return { commitHash, remote: remote.url, fileCount };
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
