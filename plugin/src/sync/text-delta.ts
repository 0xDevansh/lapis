import type * as Y from "yjs";

/**
 * Apply a content change to Y.Text using common-prefix/suffix trimming so
 * typical mid-file edits produce a small CRDT update instead of rewriting
 * the whole string.
 */
export function applyTextDelta(text: Y.Text, next: string): void {
  const prev = text.toString();
  if (prev === next) return;

  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1;
  }

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev -= 1;
    endNext -= 1;
  }

  const deleteLen = endPrev - start;
  if (deleteLen > 0) text.delete(start, deleteLen);
  const insert = next.slice(start, endNext);
  if (insert.length > 0) text.insert(start, insert);
}
