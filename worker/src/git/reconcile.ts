/**
 * GitHub inbound reconciliation — Slice 26.
 *
 * Fetches the remote branch, diffs against last_synced_commit, and applies
 * per-file three-way merges into the vault via the coordinator write path.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../artifacts/memory-fs";
import { merge3 } from "../vault/patch";
import type { ChangeNotification } from "../vault/coordinator";
import type { ConflictContext } from "../vault/conflict";
import type { GitRemote } from "./remote";
import { gitPathFromVault, vaultPathFromGit } from "./remote";
import type { ManifestEntry } from "../vault/manifest";
import { parseLfsPointer } from "./lfs-pointer";
import { isTextContentType } from "../vault/contracts";

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

interface GitTextFile {
  content: string;
  lfsPointer: boolean;
}

interface GitTreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

async function listTreeAtCommit(
  remote: GitRemote,
  commitOid: string | null
): Promise<Map<string, GitTextFile>> {
  const dir = "/reconcile";
  const fs = new MemoryFS();
  const auth = remote.onAuth();
  const files = new Map<string, GitTextFile>();

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
      noCheckout: true,
      onAuth: () => auth,
    });

    const commit = await git.readCommit({ fs, dir, oid: commitOid });
    async function walk(treeOid: string, prefix: string): Promise<void> {
      const result = await git.readTree({ fs, dir, oid: treeOid });
      for (const entry of result.tree as GitTreeEntry[]) {
        const rel = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") {
          await walk(entry.oid, rel);
          continue;
        }
        if (entry.type !== "blob") continue;
        const vaultPath = vaultPathFromGit(remote.subdir, rel);
        if (!vaultPath) continue;
        const raw = await git.readBlob({ fs, dir, oid: entry.oid });
        const content = new TextDecoder().decode(raw.blob);
        files.set(vaultPath.toLowerCase(), {
          content,
          lfsPointer: parseLfsPointer(content) !== null,
        });
      }
    }
    await walk(commit.commit.tree, "");
  } catch {
    // empty tree on first sync
  }
  return files;
}

export async function reconcileInbound(deps: ReconcileDeps): Promise<ReconcileResult> {
  const author = `github:${deps.vaultId}`;
  const baseTree = await listTreeAtCommit(deps.remote, deps.lastSyncedCommit);
  const headOid = await fetchHeadOid(deps.remote);
  const theirsTree = headOid ? await listTreeAtCommit(deps.remote, headOid) : new Map<string, GitTextFile>();

  const paths = new Set([...baseTree.keys(), ...theirsTree.keys()]);
  const applied: ChangeNotification[] = [];

  for (const key of paths) {
    const baseFile = baseTree.get(key);
    const theirs = theirsTree.get(key);
    if (theirs === undefined) continue; // deleted on GitHub — skip inbound delete for safety
    if (baseFile?.lfsPointer || theirs.lfsPointer) continue; // binary pointers are handled by Lapis live sync

    const entry = deps.getEntry(key);
    if (entry && !isTextContentType(entry.contentType)) continue;
    const ours = entry ? await deps.getHeadText(entry.path) : "";
    const base = baseFile?.content ?? "";
    const theirsContent = theirs.content;

    if (theirsContent === base) continue; // only vault changed — outbound handles
    if (theirsContent === ours) continue; // already converged

    if (!entry) {
      const result = await deps.applyMerged(key, theirsContent, author);
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

    const { merged, hasConflicts } = merge3(base, ours, theirsContent);
    if (hasConflicts) {
      const ctx: ConflictContext = {
        path: entry.path,
        serverContent: ours,
        clientContent: theirsContent,
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
