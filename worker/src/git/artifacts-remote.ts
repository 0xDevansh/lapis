/**
 * Cloudflare Artifacts GitRemote adapter — Slice 25.
 */

import { ensureRepoAndToken } from "../artifacts/sealer";
import type { GitRemote } from "./remote";

export class ArtifactsRemote implements GitRemote {
  readonly provider = "artifacts";
  readonly branch = "main";
  readonly subdir?: string;

  private constructor(
    readonly url: string,
    private readonly tokenSecret: string
  ) {}

  onAuth() {
    return { username: "x", password: this.tokenSecret };
  }

  static async create(
    artifacts: Artifacts,
    vaultId: string,
    existingRemote: string | null
  ): Promise<ArtifactsRemote> {
    const { remote, tokenSecret } = await ensureRepoAndToken(artifacts, vaultId, existingRemote);
    return new ArtifactsRemote(remote, tokenSecret);
  }
}
