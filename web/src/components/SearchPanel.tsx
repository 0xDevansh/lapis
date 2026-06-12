/**
 * SearchPanel — keyword search for Vault Content via D1 FTS.
 * Renders inline in the sidebar below the file tree.
 */

import React, { useState, useRef, useCallback } from "react";
import * as api from "../api";

interface Props {
  vaultId: string;
  onSelect: (path: string) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}

export default function SearchPanel({ vaultId, onSelect, inputRef }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.SearchResult[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults(null);
        setActiveIndex(0);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      api
        .searchVault(vaultId, q)
        .then((r) => {
          setResults(r);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch((e: Error) => {
          setError(e.message);
          setLoading(false);
        });
    },
    [vaultId]
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(val), 300);
  }

  function closeSearch() {
    setQuery("");
    setResults(null);
    setActiveIndex(0);
  }

  function selectResult(result: api.SearchResult) {
    closeSearch();
    onSelect(result.path);
    inputRef?.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!results || results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      selectResult(results[activeIndex] ?? results[0]);
    }
  }

  /** Render snippet with **bold** markers */
  function renderSnippet(raw: string): React.ReactNode {
    const parts = raw.split(/(\*\*[^*]+\*\*)/);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) {
        return <strong key={i}>{p.slice(2, -2)}</strong>;
      }
      return <span key={i}>{p}</span>;
    });
  }

  return (
    <div style={styles.panel}>
      <input
        ref={inputRef}
        style={styles.input}
        type="search"
        placeholder="Search notes…"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Search vault"
        aria-activedescendant={results?.[activeIndex] ? `search-result-${activeIndex}` : undefined}
      />

      {loading && <p style={styles.muted}>Searching…</p>}
      {error && <p style={styles.err}>{error}</p>}

      {results !== null && results.length === 0 && !loading && (
        <p style={styles.muted}>No results for "{query}"</p>
      )}

      {results && results.length > 0 && (
        <ul style={styles.list}>
          {results.map((r, index) => (
            <li key={r.path} style={styles.item}>
              <button
                id={`search-result-${index}`}
                style={index === activeIndex ? styles.resultBtnActive : styles.resultBtn}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(r)}
              >
                <span style={styles.resultPath}>{r.path}</span>
                {r.snippet && (
                  <span style={styles.snippet}>{renderSnippet(r.snippet)}</span>
                )}
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
    borderBottom: "1px solid #e0e0e0",
    padding: "0.4rem 0.6rem",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "0.35rem 0.5rem",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    fontSize: "0.8rem",
    fontFamily: "var(--font-sans)",
    outline: "none",
    background: "#fff",
    color: "#1a1a1a",
  },
  muted: {
    color: "#6b6b6b",
    fontSize: "0.78rem",
    margin: "0.35rem 0 0",
    padding: 0,
  },
  err: {
    color: "#c0392b",
    fontSize: "0.78rem",
    margin: "0.35rem 0 0",
  },
  list: {
    listStyle: "none",
    margin: "0.3rem 0 0",
    padding: 0,
  },
  item: {
    margin: 0,
    padding: 0,
  },
  resultBtn: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    borderRadius: 4,
    padding: "0.3rem 0.4rem",
    cursor: "pointer",
    lineHeight: 1.4,
  },
  resultBtnActive: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "#ede8f8",
    border: "none",
    borderRadius: 4,
    padding: "0.3rem 0.4rem",
    cursor: "pointer",
    lineHeight: 1.4,
  },
  resultPath: {
    display: "block",
    fontSize: "0.78rem",
    fontFamily: "var(--font-mono)",
    color: "#7c5cbf",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  snippet: {
    display: "block",
    fontSize: "0.75rem",
    color: "#444",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
