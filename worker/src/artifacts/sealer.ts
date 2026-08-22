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
import { isTextContentType } from "../vault/contracts";
import { formatLfsPointer } from "../git/lfs-pointer";
export interface SealResult {
  commitHash: string;
  repoName: string;
  remote: string;
  fileCount: number;
}

export interface IncrementalSealChange {
  path: string;
  deleted?: boolean;
  contentType?: string;
  size?: number;
  blobOid?: string;
}

export interface SealedCommit {
  hash: string;
  message: string;
  ts: string;
  author: string;
}

interface GitTreeBlob {
  mode: string;
  oid: string;
  type: "blob";
}

interface GitTreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** Artifacts repo name for a vault. Must start with a letter per naming rules. */
export function repoName(vaultId: string): string {
  return `vault-${vaultId}`;
}

async function readTreeMap(
  fs: MemoryFS,
  dir: string,
  commitOid: string
): Promise<Map<string, GitTreeBlob>> {
  const commit = await git.readCommit({ fs, dir, oid: commitOid });
  const out = new Map<string, GitTreeBlob>();

  async function walkTree(treeOid: string, prefix: string): Promise<void> {
    const result = await git.readTree({ fs, dir, oid: treeOid });
    for (const entry of result.tree as GitTreeEntry[]) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === "tree") {
        await walkTree(entry.oid, path);
      } else if (entry.type === "blob") {
        out.set(path, { mode: entry.mode, oid: entry.oid, type: "blob" });
      }
    }
  }

  await walkTree(commit.commit.tree, "");
  return out;
}

async function writeTreeMap(
  fs: MemoryFS,
  dir: string,
  files: Map<string, GitTreeBlob>
): Promise<string> {
  interface TreeNode {
    files: Map<string, GitTreeBlob>;
    dirs: Map<string, TreeNode>;
  }
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, blob] of files) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], blob);
  }

  async function writeNode(node: TreeNode): Promise<string> {
    const tree: GitTreeEntry[] = [];
    for (const [path, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      tree.push({
        mode: "040000",
        path,
        oid: await writeNode(child),
        type: "tree",
      });
    }
    for (const [path, blob] of [...node.files].sort(([a], [b]) => a.localeCompare(b))) {
      tree.push({ ...blob, path });
    }
    return git.writeTree({ fs, dir, tree });
  }

  return writeNode(root);
}

async function readBlobAtPath(
  fs: MemoryFS,
  dir: string,
  commitOid: string,
  filepath: string
): Promise<Uint8Array | null> {
  const tree = await readTreeMap(fs, dir, commitOid);
  const entry = tree.get(filepath);
  if (!entry) return null;
  const blob = await git.readBlob({ fs, dir, oid: entry.oid });
  return blob.blob;
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
  let parent: string | null = null;
  let tree = new Map<string, GitTreeBlob>();

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote.url,
      ref: remote.branch,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
      onAuth: () => auth,
    });
    parent = await git.resolveRef({ fs, dir, ref: remote.branch });
    tree = await readTreeMap(fs, dir, parent);
  } catch {
    await git.init({ fs, dir, defaultBranch: remote.branch });
  }

  let fileCount = 0;
  for (const change of changes) {
    const gitPath = gitPathFromVault(remote.subdir, change.path);
    if (!gitPath) continue;

    if (change.deleted) {
      if (tree.delete(gitPath)) fileCount++;
      continue;
    }

    let content: Uint8Array;
    if (change.blobOid && change.contentType && !isTextContentType(change.contentType)) {
      content = new TextEncoder().encode(
        formatLfsPointer({ oid: change.blobOid, size: change.size ?? 0 })
      );
    } else {
      const bytes = await readFile(change.path);
      if (bytes === null) continue;
      content = new Uint8Array(bytes);
    }
    const oid = await git.writeBlob({ fs, dir, blob: content });
    tree.set(gitPath, { mode: "100644", oid, type: "blob" });
    fileCount++;
  }

  if (fileCount === 0) {
    return { commitHash: "", repoName: repoName(vaultId), remote: remote.url, fileCount };
  }

  const now = new Date();
  const commitMessage = label
    ? `seal: ${label} (${now.toISOString()})`
    : `seal: snapshot ${now.toISOString()}`;

  const treeOid = await writeTreeMap(fs, dir, tree);
  const author = {
    name: commitAuthor,
    email: "lapis@seal",
    timestamp: Math.floor(now.getTime() / 1000),
    timezoneOffset: 0,
  };
  const commitHash = await git.writeCommit({
    fs,
    dir,
    commit: {
      message: commitMessage,
      tree: treeOid,
      parent: parent ? [parent] : [],
      author,
      committer: author,
    },
  });
  await git.writeRef({
    fs,
    dir,
    ref: `refs/heads/${remote.branch}`,
    value: commitHash,
    force: true,
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
      noCheckout: true,
      onAuth: () => auth,
    });

    return await readBlobAtPath(fs, dir, commitHash, gitPath);
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
      noCheckout: true,
      onAuth: () => ({ username: "x", password: tokenSecret }),
    });

    return await readBlobAtPath(fs, dir, commitHash, filePath);
  } catch {
    return null;
  }
}
