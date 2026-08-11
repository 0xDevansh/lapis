import { useCallback, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { LapisYjsProvider } from "../lib/yjs-provider";
import {
  createTextFile,
  fileIdForPath,
  getText,
  listActivePaths,
  renamePath,
  softDeletePath,
  toManifestEntries,
  writeTextPath,
  type ActivePath,
} from "../lib/yjs-schema";

export function useVaultYjs(vaultId: string | undefined) {
  const [provider, setProvider] = useState<LapisYjsProvider | null>(null);
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!vaultId) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/vaults/${vaultId}/yjs`;
    const p = new LapisYjsProvider(url);
    setProvider(p);

    const bump = () => {
      setTick((t) => t + 1);
      setReady(true);
      setConnected(true);
    };
    p.doc.on("update", bump);
    const t = setTimeout(bump, 400);

    return () => {
      clearTimeout(t);
      p.doc.off("update", bump);
      p.destroy();
      setProvider(null);
      setReady(false);
      setConnected(false);
    };
  }, [vaultId]);

  const doc = provider?.doc ?? null;

  const paths: ActivePath[] = useMemo(() => {
    void tick;
    return doc ? listActivePaths(doc) : [];
  }, [doc, tick]);

  const manifestEntries = useMemo(() => {
    void tick;
    return doc ? toManifestEntries(doc) : [];
  }, [doc, tick]);

  const readText = useCallback(
    (path: string): string | null => {
      if (!doc) return null;
      const id = fileIdForPath(doc, path);
      if (!id) return null;
      return getText(doc, id);
    },
    [doc]
  );

  const saveText = useCallback(
    (path: string, content: string, contentType = "text/markdown") => {
      if (!doc) throw new Error("Vault CRDT not ready");
      writeTextPath(doc, path, content, contentType);
    },
    [doc]
  );

  const createNote = useCallback(
    (path: string, content = "") => {
      if (!doc) throw new Error("Vault CRDT not ready");
      return createTextFile(doc, path, content, "text/markdown");
    },
    [doc]
  );

  const rename = useCallback(
    (oldPath: string, newPath: string) => {
      if (!doc) throw new Error("Vault CRDT not ready");
      if (!renamePath(doc, oldPath, newPath)) throw new Error("File not found");
    },
    [doc]
  );

  const remove = useCallback(
    (path: string) => {
      if (!doc) throw new Error("Vault CRDT not ready");
      if (!softDeletePath(doc, path)) throw new Error("File not found");
    },
    [doc]
  );

  return {
    provider,
    doc: doc as Y.Doc | null,
    paths,
    manifestEntries,
    ready,
    connected,
    readText,
    saveText,
    createNote,
    rename,
    remove,
  };
}
