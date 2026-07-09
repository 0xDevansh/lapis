/**
 * OutlinePanel — lists the headings of the active note and lets the reader jump
 * to them. Headings are emitted in document order; clicking one dispatches a
 * `lapis:outline-jump` event (with the heading's index) that the rendered
 * preview (MarkdownView) listens for and scrolls into view.
 */

import { useMemo } from "react";
import { ListBullets } from "@phosphor-icons/react";
import { splitFrontmatter } from "../markdown/frontmatter";

interface Heading {
  level: number;
  text: string;
  index: number;
}

interface Props {
  /** Raw Markdown source of the active note, or null when none is open. */
  source: string | null;
}

/**
 * Parse ATX headings, skipping fenced code blocks and a leading YAML
 * frontmatter block, so indices line up with the headings rendered by `marked`.
 */
export function parseHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  const { content } = splitFrontmatter(source);
  let lines = content.split("\n");

  let inFence = false;
  let fenceMarker = "";
  let index = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (line[0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim(), index });
      index++;
    }
  }

  return headings;
}

export default function OutlinePanel({ source }: Props) {
  const headings = useMemo(() => (source ? parseHeadings(source) : []), [source]);

  if (!source) {
    return <p className="px-1 py-2 text-[13px] text-muted">Open a note to see its outline.</p>;
  }

  if (headings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-1 py-8 text-center">
        <ListBullets size={24} weight="duotone" className="text-faint" />
        <p className="text-[13px] text-muted">No headings in this note.</p>
      </div>
    );
  }

  const minLevel = Math.min(...headings.map((h) => h.level));

  const jump = (index: number) => {
    window.dispatchEvent(new CustomEvent("lapis:outline-jump", { detail: { index } }));
  };

  return (
    <ul className="flex flex-col gap-0.5">
      {headings.map((h) => (
        <li key={h.index}>
          <button
            onClick={() => jump(h.index)}
            title={h.text}
            className="block w-full truncate rounded-sm py-1 pr-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
            style={{ paddingLeft: 8 + (h.level - minLevel) * 14 }}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
