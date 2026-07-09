import type { ReactNode } from "react";

interface FrontmatterPanelProps {
  data: Record<string, unknown>;
  tags?: string[];
}

const HEADER_KEYS = new Set(["title", "tags", "tag"]);

const KEY_ORDER = [
  "aliases",
  "status",
  "author",
  "category",
  "publisher",
  "isbn",
  "created",
  "updated",
  "date",
  "cssclass",
  "cssclasses",
];

function formatKey(key: string): string {
  return key
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "number") return String(value);
  return String(value);
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(value);
}

function isDateKey(key: string): boolean {
  return /(?:^|_)(?:date|created|updated|modified)(?:$|_)/i.test(key) || key === "created" || key === "updated";
}

function formatDateValue(value: string): string {
  const normalized = value.includes(" ") && !value.includes("T") ? value.replace(" ", "T") : value;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return value;
  const hasTime = /[T ]\d{2}:\d{2}/.test(value);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: hasTime ? "2-digit" : undefined,
    minute: hasTime ? "2-digit" : undefined,
  });
}

function sortEntries(entries: [string, unknown][]): [string, unknown][] {
  return [...entries].sort(([a], [b]) => {
    const ai = KEY_ORDER.indexOf(a.toLowerCase());
    const bi = KEY_ORDER.indexOf(b.toLowerCase());
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
}

function renderValue(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="frontmatter-empty">—</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span className={`frontmatter-bool ${value ? "is-true" : "is-false"}`}>
        {value ? "Yes" : "No"}
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="frontmatter-empty">—</span>;
    return (
      <div className="frontmatter-pills">
        {value.map((item, i) => (
          <span key={`${key}-${i}`} className="frontmatter-pill">
            {formatScalar(item)}
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <pre className="frontmatter-nested">{JSON.stringify(value, null, 2)}</pre>
    );
  }

  if (typeof value === "string") {
    if (key === "status") {
      return <span className="frontmatter-status">{value}</span>;
    }
    if (isDateKey(key) || isIsoDateString(value)) {
      return <time dateTime={value}>{formatDateValue(value)}</time>;
    }
    if (key === "isbn") {
      return <span className="frontmatter-mono">{value}</span>;
    }
  }

  return <span>{formatScalar(value)}</span>;
}

export default function FrontmatterPanel({ data, tags = [] }: FrontmatterPanelProps) {
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const entries = sortEntries(
    Object.entries(data).filter(([key]) => !HEADER_KEYS.has(key))
  );

  if (!title && entries.length === 0 && tags.length === 0) return null;

  return (
    <header className="frontmatter-panel">
      <div className="frontmatter-header">
        {title ? <h1 className="frontmatter-title">{title}</h1> : null}
        {tags.length > 0 && (
          <div className="frontmatter-tags">
            {tags.map((t) => (
              <span key={t} className="frontmatter-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="frontmatter-properties">
          {entries.map(([key, value]) => (
            <div key={key} className="frontmatter-property">
              <span className="frontmatter-label">{formatKey(key)}</span>
              <span className="frontmatter-value">{renderValue(key, value)}</span>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
