/**
 * GitHub inbound reconciliation — Slice 26.
 *
 * Fetches the remote branch, diffs against last_synced_commit, and applies
 * per-file three-way merges into the vault via the coordinator write path.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { merge3 } from "../vault/patch";
import type { ChangeNotification } from "../vault/coordinator";
import type { ConflictContext } from "../vault/conflict";
import type { GitRemote } from "./remote";
import { gitPathFromVault, vaultPathFromGit } from "./remote";
import type { ManifestEntry } from "../vault/manifest";

export interface ReconcileDeps {
  remote: GitRemote;
  vaultId: string;
  lastSyncedCommit: string | null;
  getHeadText: (path: string) => Promise<string>;
  getEntry: (path: string) => (ManifestEntry & { r2Revision: number }) | null;
  applyMerged: (path: string, content: string, author: string) => Promise<{ revision: number }>;
  writeConflictNote: (ctx: ConflictContext, author: string) => Promise<string>;
}

export interface ReconcileResult {
  applied: ChangeNotification[];
  newCommit: string | null;
}

async function listTreeAtCommit(
  remote: GitRemote,
  commitOid: string | null
): Promise<Map<string, string>> {
  const dir = "/reconcile";
  const fs = new MemoryFS();
  const auth = remote.onAuth();
  const files = new Map<string, string>();

  if (!commitOid) return files;

  try {
    await git.clone({
      fs,
      http,
      dir,
      url: remote.url,
      ref: commitOid,
      singleBranch: true,
      depth: 1,
      noCheckout: false,
      onAuth: () => auth,
    });

    async function walk(prefix: string): Promise<void> {
      const entries = await fs.promises.readdir(`${dir}/${prefix}`).catch(() => [] as string[]);
      for (const name of entries) {
        const rel = prefix ? `${prefix}/${name}` : name;
        const stat = await fs.promises.stat(`${dir}/${rel}`);
        if (stat.isDirectory()) {
          await walk(rel);
        } else {
          const vaultPath = vaultPathFromGit(remote.subdir, rel);
          if (!vaultPath) continue;
          const raw = await fs.promises.readFile(`${dir}/${rel}`);
          files.set(vaultPath.toLowerCase(), typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        }
      }
    }
    await walk("");
  } catch {
    // empty tree on first sync
  }
  return files;
}

export async function reconcileInbound(deps: ReconcileDeps): Promise<ReconcileResult> {
  const author = `github:${deps.vaultId}`;
  const baseTree = await listTreeAtCommit(deps.remote, deps.lastSyncedCommit);
  const headOid = await fetchHeadOid(deps.remote);
  const theirsTree = headOid ? await listTreeAtCommit(deps.remote, headOid) : new Map<string, string>();

  const paths = new Set([...baseTree.keys(), ...theirsTree.keys()]);
  const applied: ChangeNotification[] = [];

  for (const key of paths) {
    const base = baseTree.get(key) ?? "";
    const theirs = theirsTree.get(key);
    if (theirs === undefined) continue; // deleted on GitHub — skip inbound delete for safety

    const entry = deps.getEntry(key);
    const ours = entry ? await deps.getHeadText(entry.path) : "";

    if (theirs === base) continue; // only vault changed — outbound handles
    if (theirs === ours) continue; // already converged

    if (!entry) {
      const result = await deps.applyMerged(key, theirs, author);
      applied.push({
        type: "change",
        path: key,
        kind: "put",
        baseRevision: 0,
        revision: result.revision,
        author,
        ts: new Date().toISOString(),
      });
      continue;
    }

    const { merged, hasConflicts } = merge3(base, ours, theirs);
    if (hasConflicts) {
      const ctx: ConflictContext = {
        path: entry.path,
        serverContent: ours,
        clientContent: theirs,
        baseContent: base || undefined,
        serverRevision: entry.revision,
        clientBaseRevision: entry.revision,
        deviceName: author,
        timestamp: new Date().toISOString(),
      };
      const notePath = await deps.writeConflictNote(ctx, author);
      applied.push({
        type: "change",
        path: notePath,
        kind: "put",
        author,
        ts: new Date().toISOString(),
      });
      continue;
    }

    const result = await deps.applyMerged(entry.path, merged, author);
    applied.push({
      type: "change",
      path: entry.path,
      kind: "put",
      baseRevision: entry.revision,
      revision: result.revision,
      author,
      ts: new Date().toISOString(),
    });
  }

  return { applied, newCommit: headOid };
}

async function fetchHeadOid(remote: GitRemote): Promise<string | null> {
  const dir = "/head";
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
      noCheckout: true,
      onAuth: () => auth,
    });
    const oid = await git.resolveRef({ fs, dir, ref: remote.branch });
    return oid;
  } catch {
    return null;
  }
}

export function gitPathForVault(remote: GitRemote, vaultPath: string): string {
  return gitPathFromVault(remote.subdir, vaultPath);
}
