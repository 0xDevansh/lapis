import React, { useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { parseFrontmatter } from "../markdown/frontmatter";
import { renderMarkdown } from "../markdown/renderer";

interface MarkdownViewProps {
  source: string;
  vaultId: string;
  /** All canonical vault paths for wikilink resolution */
  vaultPaths: string[];
  onCreateNote?: (path: string) => void;
  /** Called when the user clicks a wikilink that navigates within the vault */
  onNavigate?: (path: string) => void;
}

export default function MarkdownView({
  source,
  vaultId,
  vaultPaths,
  onCreateNote,
  onNavigate,
}: MarkdownViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const { data, content, tags } = useMemo(
    () => parseFrontmatter(source),
    [source]
  );

  const html = useMemo(
    () =>
      renderMarkdown(content, {
        vaultId,
        vaultPaths,
        onCreateNote,
      }),
    [content, vaultId, vaultPaths, onCreateNote]
  );

  // Wire up wikilink clicks
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;

      // Broken wikilink create-note action
      const createPath = anchor.dataset.createPath;
      if (createPath) {
        e.preventDefault();
        const decoded = decodeURIComponent(createPath);
        if (onCreateNote) onCreateNote(decoded);
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href) return;

      // Internal vault links
      if (href.startsWith(`/vault/${vaultId}/`)) {
        e.preventDefault();
        const rawPath = href.slice(`/vault/${vaultId}/`.length).replace(/^file\//, "").split("#", 1)[0];
        const path = rawPath
          .split("/")
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          })
          .join("/");
        if (onNavigate) onNavigate(path);
        else navigate(href);
      }
    }

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [vaultId, onCreateNote, onNavigate, navigate]);

  const title = (data.title as string | undefined) ?? null;
  const hasFrontmatter = title || tags.length > 0 || Object.keys(data).length > 0;

  return (
    <div style={styles.wrapper}>
      {hasFrontmatter && (
        <div style={styles.frontmatter}>
          {title && <div style={styles.fmTitle}>{title}</div>}
          {tags.length > 0 && (
            <div style={styles.tagRow}>
              {tags.map((t) => (
                <span key={t} style={styles.tag}>
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="markdown-body"
        style={styles.body}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    padding: "1.5rem 2rem",
    maxWidth: 740,
    margin: "0 auto",
    width: "100%",
  },
  frontmatter: {
    marginBottom: "1.25rem",
    paddingBottom: "1rem",
    borderBottom: "1px solid #e0e0e0",
  },
  fmTitle: {
    fontSize: "1.6rem",
    fontWeight: 700,
    marginBottom: "0.4rem",
    color: "#1a1a1a",
  },
  tagRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.4rem",
    marginTop: "0.3rem",
  },
  tag: {
    background: "#ede8f8",
    color: "#7c5cbf",
    borderRadius: 4,
    padding: "0.15rem 0.5rem",
    fontSize: "0.8rem",
    fontWeight: 500,
  },
  body: {
    lineHeight: 1.7,
    fontSize: "1rem",
    color: "#1a1a1a",
  },
};
