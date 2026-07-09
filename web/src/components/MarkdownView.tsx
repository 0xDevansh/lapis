import { useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import FrontmatterPanel from "./FrontmatterPanel";
import { parseFrontmatter } from "../markdown/frontmatter";
import { renderMarkdown } from "../markdown/renderer";
import type { ManifestEntry } from "../api";

interface MarkdownViewProps {
  source: string;
  vaultId: string;
  /** Path of the note being previewed (for relative image resolution). */
  currentPath?: string;
  /** All canonical vault paths for wikilink resolution */
  vaultPaths: string[];
  /** Manifest entries for embedded image metadata */
  manifestEntries?: Record<string, ManifestEntry>;
  onCreateNote?: (path: string) => void;
  /** Called when the user clicks a wikilink that navigates within the vault */
  onNavigate?: (path: string) => void;
}

export default function MarkdownView({
  source,
  vaultId,
  currentPath,
  vaultPaths,
  manifestEntries,
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
        currentPath,
        manifestEntries,
        onCreateNote,
      }),
    [content, vaultId, vaultPaths, currentPath, manifestEntries, onCreateNote]
  );

  const hasFrontmatter = Object.keys(data).length > 0 || tags.length > 0;

  // Wire up wikilink clicks
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;

      const createPath = anchor.dataset.createPath;
      if (createPath) {
        e.preventDefault();
        const decoded = decodeURIComponent(createPath);
        if (onCreateNote) onCreateNote(decoded);
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href) return;

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

  // Scroll to a heading when the Outline panel requests a jump (by document order).
  useEffect(() => {
    function onJump(e: Event) {
      const idx = (e as CustomEvent<{ index: number }>).detail?.index;
      const container = containerRef.current;
      if (!container || idx == null) return;
      const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const el = headings[idx] as HTMLElement | undefined;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.addEventListener("lapis:outline-jump", onJump as EventListener);
    return () => window.removeEventListener("lapis:outline-jump", onJump as EventListener);
  }, []);

  return (
    <div className="markdown-preview w-full px-8 py-6">
      {hasFrontmatter && <FrontmatterPanel data={data} tags={tags} />}
      <div
        ref={containerRef}
        className="markdown-body"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
