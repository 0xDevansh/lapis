/**
 * BacklinksPanel — shows all notes that link to the currently open file.
 * Rendered inside the right workspace panel under the "Backlinks" tab.
 */

import { useEffect, useState } from "react";
import { LinkSimple, FileText } from "@phosphor-icons/react";
import * as api from "../api";

interface Props {
  vaultId: string;
  path: string;
  onNavigate: (path: string) => void;
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

export default function BacklinksPanel({ vaultId, path, onNavigate }: Props) {
  const [backlinks, setBacklinks] = useState<api.BacklinkResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBacklinks(null);
    setError(null);
    api
      .getBacklinks(vaultId, path)
      .then(setBacklinks)
      .catch((e: Error) => setError(e.message));
  }, [vaultId, path]);

  if (error) {
    return <p className="px-1 py-2 text-[13px] text-danger">{error}</p>;
  }

  if (!backlinks) {
    return <p className="px-1 py-2 text-[13px] text-muted">Loading backlinks…</p>;
  }

  if (backlinks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-1 py-8 text-center">
        <LinkSimple size={24} weight="duotone" className="text-faint" />
        <p className="text-[13px] text-muted">No notes link here.</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {backlinks.map((bl) => (
        <li key={bl.sourcePath}>
          <button
            onClick={() => onNavigate(bl.sourcePath)}
            title={bl.sourcePath}
            className="group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <FileText size={15} className="shrink-0 text-accent-soft" />
            <span className="min-w-0 flex-1 truncate">{basename(bl.sourcePath)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
