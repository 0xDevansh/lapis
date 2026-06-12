import type { ManifestEntry, SyncJournal, VaultManifest } from "../types";
import { lowerPath } from "./paths";

export function emptyJournal(vaultId: string): SyncJournal {
  return {
    version: 1,
    vaultId,
    lastSyncAt: new Date().toISOString(),
    fileRevisions: {},
    fileHashes: {},
    pendingOps: [],
  };
}

export function isValidJournal(value: unknown, vaultId: string): value is SyncJournal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const journal = value as Partial<SyncJournal>;
  return journal.version === 1 && journal.vaultId === vaultId && typeof journal.fileRevisions === "object" && typeof journal.fileHashes === "object" && Array.isArray(journal.pendingOps);
}

export function setEntry(journal: SyncJournal, entry: ManifestEntry, hash?: string) {
  const key = lowerPath(entry.path);
  journal.fileRevisions[key] = entry.revision;
  if (hash) {
    journal.fileHashes[key] = hash;
  }
  journal.lastSyncAt = new Date().toISOString();
}

export function removeEntry(journal: SyncJournal, path: string) {
  const key = lowerPath(path);
  delete journal.fileRevisions[key];
  delete journal.fileHashes[key];
  journal.lastSyncAt = new Date().toISOString();
}

export function revisionsFromManifest(manifest: VaultManifest, hashes: Record<string, string>): SyncJournal {
  const journal = emptyJournal(manifest.vaultId);
  for (const entry of Object.values(manifest.entries)) {
    const key = lowerPath(entry.path);
    journal.fileRevisions[key] = entry.revision;
    if (hashes[key]) {
      journal.fileHashes[key] = hashes[key];
    }
  }
  return journal;
}
