/**
 * Unified diff patch application — Slice 09.
 *
 * Applies a standard unified diff (as produced by GNU diff / git diff) to a
 * source string and returns the patched result, or `null` if the patch cannot
 * be applied cleanly (context mismatch or invalid format).
 *
 * This is intentionally a minimal implementation covering the subset needed by
 * the Lapis sync protocol: single-file unified diffs, context lines, hunks with
 * @@ markers. Three-way merge for stale patches is handled in Slice 11.
 */

interface Hunk {
  origStart: number; // 1-based
  origLen: number;
  newStart: number;
  newLen: number;
  lines: string[]; // each prefixed with ' ', '+', or '-'
}

/**
 * Parse unified diff hunks from a patch string.
 * Returns null if the patch cannot be parsed.
 */
function parseHunks(patch: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  const lines = patch.split("\n");

  let i = 0;
  // Skip file headers (--- / +++ lines)
  while (i < lines.length && !lines[i].startsWith("@@")) {
    i++;
  }

  while (i < lines.length) {
    const headerMatch = lines[i].match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (!headerMatch) {
      // Non-hunk line outside a hunk — skip (could be diff header noise)
      i++;
      continue;
    }

    const origStart = parseInt(headerMatch[1], 10);
    const origLen = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
    const newStart = parseInt(headerMatch[3], 10);
    const newLen = headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1;

    i++;
    const hunkLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const l = lines[i];
      if (l === "\\ No newline at end of file") {
        i++;
        continue;
      }
      hunkLines.push(l);
      i++;
    }

    hunks.push({ origStart, origLen, newStart, newLen, lines: hunkLines });
  }

  return hunks.length > 0 ? hunks : null;
}

/**
 * Apply a unified diff to `original`.
 * Returns the patched string, or `null` if the patch does not apply cleanly.
 */
export function applyPatch(original: string, patch: string): string | null {
  const hunks = parseHunks(patch);
  if (!hunks) return null;

  // Work with line arrays (preserve line endings as-is)
  const origLines = original === "" ? [] : original.split("\n");

  // We process hunks in order, tracking offset between original and output
  const output: string[] = [];
  let origIdx = 0; // 0-based index into origLines (next line to consume)

  for (const hunk of hunks) {
    const hunkOrigStart = hunk.origStart - 1; // convert to 0-based

    // Lines before the hunk start: copy unchanged
    if (hunkOrigStart < origIdx) {
      // Overlapping hunks — malformed patch
      return null;
    }
    while (origIdx < hunkOrigStart) {
      output.push(origLines[origIdx]);
      origIdx++;
    }

    // Process hunk lines
    let contextOrig = hunkOrigStart;
    for (const hline of hunk.lines) {
      const prefix = hline[0];
      const content = hline.slice(1);

      if (prefix === " ") {
        // Context line — must match original
        if (contextOrig >= origLines.length || origLines[contextOrig] !== content) {
          return null; // context mismatch
        }
        output.push(content);
        contextOrig++;
        origIdx++;
      } else if (prefix === "-") {
        // Remove line — must match original
        if (contextOrig >= origLines.length || origLines[contextOrig] !== content) {
          return null; // mismatch
        }
        contextOrig++;
        origIdx++;
        // Do NOT push to output
      } else if (prefix === "+") {
        // Add line
        output.push(content);
        // contextOrig not advanced
      }
      // Any other prefix (e.g., '\\') is silently ignored
    }
  }

  // Append remaining lines after last hunk
  while (origIdx < origLines.length) {
    output.push(origLines[origIdx]);
    origIdx++;
  }

  return output.join("\n");
}

/**
 * Generate a simple unified diff between two strings.
 * Used by tests and the plugin SDK; not required in production paths.
 *
 * This is a naive longest-common-subsequence implementation — good enough for
 * tests but not optimized for large files.
 */
export function createPatch(
  path: string,
  original: string,
  modified: string,
  revision: number
): string {
  const origLines = original === "" ? [] : original.split("\n");
  const modLines = modified === "" ? [] : modified.split("\n");

  const lcs = computeLCS(origLines, modLines);
  const hunks = buildHunks(origLines, modLines, lcs);

  if (hunks.length === 0) return ""; // no changes

  const header = `--- a/${path}\t(revision ${revision})\n+++ b/${path}\n`;
  return header + hunks.map(formatHunk).join("");
}

// ── LCS helpers ───────────────────────────────────────────────────────────────

function computeLCS(a: string[], b: string[]): boolean[][] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find which lines are in LCS
  const inLcsA: boolean[] = new Array(m).fill(false);
  const inLcsB: boolean[] = new Array(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      inLcsA[i - 1] = true;
      inLcsB[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // Pack into a combined boolean[][] for use in buildHunks
  // result[i] = [inLcsA[i], ...] — just return as separate arrays via closure
  // Actually return [inLcsA, inLcsB] as a 2-row matrix for convenience
  return [inLcsA, inLcsB];
}

interface RawHunk {
  origStart: number; // 1-based
  newStart: number;
  removes: Array<{ lineNum: number; text: string }>;
  adds: Array<{ lineNum: number; text: string }>;
  contextBefore: string[];
  contextAfter: string[];
}

function buildHunks(
  orig: string[],
  mod: string[],
  lcs: boolean[][]
): RawHunk[] {
  const [inLcsOrig, inLcsMod] = lcs;

  const CONTEXT = 3;

  // Collect changed positions
  interface Change {
    origLine: number | null; // 0-based, null if addition
    modLine: number | null;  // 0-based, null if removal
    type: "remove" | "add";
  }

  const changes: Change[] = [];
  let oi = 0;
  let mi = 0;
  while (oi < orig.length || mi < mod.length) {
    if (oi < orig.length && mi < mod.length && inLcsOrig[oi] && inLcsMod[mi]) {
      // Both in LCS — unchanged
      oi++;
      mi++;
    } else if (oi < orig.length && !inLcsOrig[oi]) {
      changes.push({ origLine: oi, modLine: null, type: "remove" });
      oi++;
    } else if (mi < mod.length && !inLcsMod[mi]) {
      changes.push({ origLine: null, modLine: mi, type: "add" });
      mi++;
    } else {
      oi++;
      mi++;
    }
  }

  if (changes.length === 0) return [];

  // Group changes into hunks by proximity
  const rawHunks: RawHunk[] = [];
  let i = 0;
  while (i < changes.length) {
    const groupStart = i;
    let lastOrigLine = changes[i].origLine ?? 0;
    let lastModLine = changes[i].modLine ?? 0;
    i++;

    while (
      i < changes.length &&
      ((changes[i].origLine !== null && (changes[i].origLine! - lastOrigLine) <= CONTEXT * 2 + 1) ||
       (changes[i].modLine !== null && (changes[i].modLine! - lastModLine) <= CONTEXT * 2 + 1))
    ) {
      if (changes[i].origLine !== null) lastOrigLine = changes[i].origLine!;
      if (changes[i].modLine !== null) lastModLine = changes[i].modLine!;
      i++;
    }

    const firstChange = changes[groupStart];
    const lastChange = changes[i - 1];

    const origStart = Math.max(0, (firstChange.origLine ?? firstChange.modLine ?? 0) - CONTEXT);
    const modStart = Math.max(0, (firstChange.modLine ?? firstChange.origLine ?? 0) - CONTEXT);

    // Build context + remove + add arrays
    const removes: Array<{ lineNum: number; text: string }> = [];
    const adds: Array<{ lineNum: number; text: string }> = [];

    for (let ci = groupStart; ci < i; ci++) {
      const c = changes[ci];
      if (c.type === "remove" && c.origLine !== null) {
        removes.push({ lineNum: c.origLine, text: orig[c.origLine] });
      } else if (c.type === "add" && c.modLine !== null) {
        adds.push({ lineNum: c.modLine, text: mod[c.modLine] });
      }
    }

    const contextBefore = orig.slice(origStart, firstChange.origLine ?? origStart);
    const lastOrigInGroup = lastChange.origLine ?? (removes.at(-1)?.lineNum ?? origStart);
    const contextAfter = orig.slice(lastOrigInGroup + 1, Math.min(orig.length, lastOrigInGroup + 1 + CONTEXT));

    rawHunks.push({
      origStart: origStart + 1,
      newStart: modStart + 1,
      removes,
      adds,
      contextBefore,
      contextAfter,
    });
  }

  return rawHunks;
}

function formatHunk(h: RawHunk): string {
  const lines: string[] = [];
  for (const l of h.contextBefore) lines.push(` ${l}`);
  for (const r of h.removes) lines.push(`-${r.text}`);
  for (const a of h.adds) lines.push(`+${a.text}`);
  for (const l of h.contextAfter) lines.push(` ${l}`);

  const origLen = h.contextBefore.length + h.removes.length + h.contextAfter.length;
  const newLen = h.contextBefore.length + h.adds.length + h.contextAfter.length;

  const header = `@@ -${h.origStart},${origLen} +${h.newStart},${newLen} @@\n`;
  return header + lines.join("\n") + "\n";
}
