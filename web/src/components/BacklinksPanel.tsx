/**
 * BacklinksPanel — shows all notes that link to the currently open file.
 * Rendered at the bottom of the content pane when a Markdown file is open.
 */

import React, { useEffect, useState } from "react";
import * as api from "../api";

interface Props {
  vaultId: string;
  path: string;
  onNavigate: (path: string) => void;
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
    return (
      <div style={styles.panel}>
        <p style={styles.err}>{error}</p>
      </div>
    );
  }

  if (!backlinks) {
    return (
      <div style={styles.panel}>
        <p style={styles.muted}>Loading backlinks…</p>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <h4 style={styles.heading}>
        Backlinks
        {backlinks.length > 0 && (
          <span style={styles.count}>{backlinks.length}</span>
        )}
      </h4>

      {backlinks.length === 0 ? (
        <p style={styles.muted}>No notes link here.</p>
      ) : (
        <ul style={styles.list}>
          {backlinks.map((bl) => (
            <li key={bl.sourcePath} style={styles.item}>
              <button
                style={styles.linkBtn}
                onClick={() => onNavigate(bl.sourcePath)}
              >
                {bl.sourcePath}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    borderTop: "1px solid #e0e0e0",
    padding: "0.75rem 1.5rem 1rem",
    background: "#fafafa",
  },
  heading: {
    margin: "0 0 0.5rem",
    fontSize: "0.8rem",
    fontWeight: 700,
    color: "#6b6b6b",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
  },
  count: {
    background: "#ede8f8",
    color: "#7c5cbf",
    borderRadius: 10,
    padding: "0 0.4rem",
    fontSize: "0.72rem",
    fontWeight: 600,
  },
  muted: {
    color: "#6b6b6b",
    fontSize: "0.8rem",
    margin: 0,
  },
  err: {
    color: "#c0392b",
    fontSize: "0.8rem",
    margin: 0,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
  },
  item: {
    margin: 0,
    padding: 0,
  },
  linkBtn: {
    background: "none",
    border: "none",
    padding: "0.2rem 0",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    color: "#7c5cbf",
    textAlign: "left",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
  },
};
