/**
 * GitHub HTTPS remote — Slice 25.
 */

import { decryptPat } from "./crypto";
import type { GitRemote } from "./remote";

export interface GitHubRemoteConfig {
  repoUrl: string;
  branch: string;
  subdir?: string | null;
  patCiphertext: string;
}

export class GitHubRemote implements GitRemote {
  readonly provider = "github";
  readonly url: string;
  readonly branch: string;
  readonly subdir?: string;
  private cachedPat: string | null = null;

  constructor(
    private readonly config: GitHubRemoteConfig,
    private readonly kek: string,
    plaintextPat?: string
  ) {
    this.url = config.repoUrl.replace(/\.git$/, "");
    this.branch = config.branch || "main";
    this.subdir = config.subdir ?? undefined;
    if (plaintextPat) this.cachedPat = plaintextPat;
  }

  async resolvePat(): Promise<string> {
    if (this.cachedPat) return this.cachedPat;
    this.cachedPat = await decryptPat(this.kek, this.config.patCiphertext);
    return this.cachedPat;
  }

  onAuth(): { username: string; password: string } {
    if (!this.cachedPat) {
      throw new Error("GitHub PAT not resolved — call resolvePat() first");
    }
    return { username: "x-access-token", password: this.cachedPat };
  }
}

export async function createGitHubRemote(
  config: GitHubRemoteConfig,
  kek: string,
  plaintextPat?: string
): Promise<GitHubRemote> {
  const remote = new GitHubRemote(config, kek, plaintextPat);
  await remote.resolvePat();
  return remote;
}
