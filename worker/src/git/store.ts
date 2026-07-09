/**
 * Git remote D1 helpers — Slice 25.
 */

export interface VaultGitRemoteRow {
  vaultId: string;
  provider: string;
  repoUrl: string;
  branch: string;
  subdir: string | null;
  patCiphertext: string;
  patLast4: string | null;
  webhookSecret: string | null;
  lastSyncedCommit: string | null;
  lastSyncedAt: string | null;
  syncState: string;
}

type Row = {
  vault_id: string;
  provider: string;
  repo_url: string;
  branch: string;
  subdir: string | null;
  pat_ciphertext: string;
  pat_last4: string | null;
  webhook_secret: string | null;
  last_synced_commit: string | null;
  last_synced_at: string | null;
  sync_state: string;
};

function toRow(row: Row): VaultGitRemoteRow {
  return {
    vaultId: row.vault_id,
    provider: row.provider,
    repoUrl: row.repo_url,
    branch: row.branch,
    subdir: row.subdir,
    patCiphertext: row.pat_ciphertext,
    patLast4: row.pat_last4,
    webhookSecret: row.webhook_secret,
    lastSyncedCommit: row.last_synced_commit,
    lastSyncedAt: row.last_synced_at,
    syncState: row.sync_state,
  };
}

export async function getGitRemote(db: D1Database, vaultId: string): Promise<VaultGitRemoteRow | null> {
  const row = await db
    .prepare(
      `SELECT vault_id, provider, repo_url, branch, subdir, pat_ciphertext, pat_last4,
              webhook_secret, last_synced_commit, last_synced_at, sync_state
       FROM vault_git_remotes WHERE vault_id = ?`
    )
    .bind(vaultId)
    .first<Row>();
  return row ? toRow(row) : null;
}

export async function upsertGitRemote(
  db: D1Database,
  input: {
    vaultId: string;
    repoUrl: string;
    branch: string;
    subdir?: string | null;
    patCiphertext: string;
    patLast4: string;
    webhookSecret?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vault_git_remotes
       (vault_id, provider, repo_url, branch, subdir, pat_ciphertext, pat_last4, webhook_secret, sync_state)
       VALUES (?, 'github', ?, ?, ?, ?, ?, ?, 'idle')
       ON CONFLICT(vault_id) DO UPDATE SET
         repo_url = excluded.repo_url,
         branch = excluded.branch,
         subdir = excluded.subdir,
         pat_ciphertext = excluded.pat_ciphertext,
         pat_last4 = excluded.pat_last4,
         webhook_secret = COALESCE(excluded.webhook_secret, vault_git_remotes.webhook_secret),
         sync_state = 'idle'`
    )
    .bind(
      input.vaultId,
      input.repoUrl,
      input.branch,
      input.subdir ?? null,
      input.patCiphertext,
      input.patLast4,
      input.webhookSecret ?? null
    )
    .run();
}

export async function deleteGitRemote(db: D1Database, vaultId: string): Promise<void> {
  await db.prepare(`DELETE FROM vault_git_remotes WHERE vault_id = ?`).bind(vaultId).run();
}

export async function updateGitRemoteState(
  db: D1Database,
  vaultId: string,
  state: { syncState?: string; lastSyncedCommit?: string | null; lastSyncedAt?: string | null }
): Promise<void> {
  if (state.syncState !== undefined) {
    await db.prepare(`UPDATE vault_git_remotes SET sync_state = ? WHERE vault_id = ?`)
      .bind(state.syncState, vaultId).run();
  }
  if (state.lastSyncedCommit !== undefined || state.lastSyncedAt !== undefined) {
    await db
      .prepare(
        `UPDATE vault_git_remotes SET
           last_synced_commit = COALESCE(?, last_synced_commit),
           last_synced_at = COALESCE(?, last_synced_at)
         WHERE vault_id = ?`
      )
      .bind(state.lastSyncedCommit ?? null, state.lastSyncedAt ?? null, vaultId)
      .run();
  }
}

export function publicGitRemoteMeta(row: VaultGitRemoteRow) {
  return {
    provider: row.provider,
    repoUrl: row.repoUrl,
    branch: row.branch,
    subdir: row.subdir,
    patLast4: row.patLast4,
    lastSyncedCommit: row.lastSyncedCommit,
    lastSyncedAt: row.lastSyncedAt,
    syncState: row.syncState,
  };
}
