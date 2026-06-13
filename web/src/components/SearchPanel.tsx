/**
 * SearchPanel — keyword search for Vault Content via D1 FTS.
 * Renders inline in the sidebar below the file tree.
 */

import React, { useState, useRef, useCallback } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import * as api from "../api";

interface Props {
  vaultId: string;
  onSelect: (path: string) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
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
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
      return;
    }
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
        return (
          <strong key={i} className="font-semibold text-accent-soft">
            {p.slice(2, -2)}
          </strong>
        );
      }
      return <span key={i}>{p}</span>;
    });
  }

  return (
    <div className="border-b border-border px-2 py-2">
      <div className="relative">
        <MagnifyingGlass
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          ref={inputRef}
          className="w-full rounded border border-border bg-surface py-1.5 pl-8 pr-7 text-[13px] text-ink placeholder:text-faint outline-none transition-colors focus:border-accent"
          type="search"
          placeholder="Search notes…"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label="Search vault"
          aria-activedescendant={
            results?.[activeIndex] ? `search-result-${activeIndex}` : undefined
          }
        />
        {query && (
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {loading && <p className="mt-2 text-xs text-muted">Searching…</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {results !== null && results.length === 0 && !loading && (
        <p className="mt-2 text-xs text-muted">No results for “{query}”</p>
      )}

      {results && results.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5" role="listbox">
          {results.map((r, index) => (
            <li key={r.path} role="presentation">
              <button
                id={`search-result-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`block w-full rounded px-2 py-1.5 text-left leading-snug transition-colors ${
                  index === activeIndex ? "bg-accent/15" : "hover:bg-hover"
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(r)}
              >
                <span className="block truncate text-[13px] font-medium text-ink">
                  {basename(r.path)}
                </span>
                {r.snippet && (
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {renderSnippet(r.snippet)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
