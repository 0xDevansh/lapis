/**
 * Unified diff patch application and three-way merge — Slices 09 & 11.
 *
 * applyPatch: Applies a standard unified diff (as produced by GNU diff / git diff)
 * to a source string and returns the patched result, or `null` if the patch cannot
 * be applied cleanly (context mismatch or invalid format).
 *
 * merge3: Performs a line-level three-way merge of base/ours/theirs.
 * Returns { merged, hasConflicts }. Clean merges have hasConflicts=false.
 * Conflict regions are marked with standard conflict markers.
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

// ── Three-way merge (Slice 11) ────────────────────────────────────────────────

export interface Merge3Result {
  /** The merged content. On conflict, includes standard conflict markers. */
  merged: string;
  /** True if any conflict markers were inserted (merge was not clean). */
  hasConflicts: boolean;
}

/**
 * Perform a line-level three-way merge.
 *
 * @param base    Common ancestor text
 * @param ours    Server's current version (already diverged from base)
 * @param theirs  Client's version (also based on base or an older revision)
 *
 * Returns { merged, hasConflicts }.
 * - If hasConflicts is false, merged is the clean result.
 * - If hasConflicts is true, merged contains conflict regions wrapped in
 *   standard markers:
 *     <<<<<<< server
 *     ...server lines...
 *     =======
 *     ...client lines...
 *     >>>>>>> client
 *
 * Algorithm:
 *   1. Compute edit sequences base→ours and base→theirs (using LCS).
 *   2. Walk the three edit sequences together in "chunks" of unchanged /
 *      changed regions, following the same structure as GNU diff3.
 *   3. Unchanged regions from both sides are emitted directly.
 *   4. Regions changed by only one side are accepted.
 *   5. Regions changed by both sides with the same result are accepted.
 *   6. Regions changed by both sides differently produce conflict markers.
 */
export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  const baseLines  = base   === "" ? [] : base.split("\n");
  const ourLines   = ours   === "" ? [] : ours.split("\n");
  const theirLines = theirs === "" ? [] : theirs.split("\n");

  // Build edit sequences: arrays of { kind, baseLine?, ourLine?, theirLine? }
  // We use a simpler encoding: for each side compute the Myers-style edit
  // script as a sequence of operations on the base.

  // editScript(a, b) returns a list of Edit objects describing how to
  // transform `a` into `b`.
  type Edit =
    | { op: "equal"; ai: number; bi: number }
    | { op: "delete"; ai: number }
    | { op: "insert"; bi: number };

  function editScript(a: string[], b: string[]): Edit[] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1] + 1
          : Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
    const edits: Edit[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
        edits.push({ op: "equal", ai: i-1, bi: j-1 });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        edits.push({ op: "insert", bi: j-1 });
        j--;
      } else {
        edits.push({ op: "delete", ai: i-1 });
        i--;
      }
    }
    return edits.reverse();
  }

  const oEdits = editScript(baseLines, ourLines);
  const tEdits = editScript(baseLines, theirLines);

  // Convert edit scripts into per-base-line mappings.
  // oursMap[bi]   = index in ourLines (or -1 if deleted from ours)
  // theirsMap[bi] = index in theirLines (or -1 if deleted from theirs)
  // Also track insertions before each base position.
  const oursMap  = new Array<number>(baseLines.length).fill(-2); // -2 = unset
  const theirsMap = new Array<number>(baseLines.length).fill(-2);
  const oursInsertsBefore  = new Map<number, number[]>(); // bi → [ourLine indices]
  const theirsInsertsBefore = new Map<number, number[]>();

  let nextBase = 0;
  for (const e of oEdits) {
    if (e.op === "equal") {
      oursMap[e.ai] = e.bi;
    } else if (e.op === "delete") {
      oursMap[e.ai] = -1;
    } else {
      // insert before nextBase
      const key = nextBase;
      const arr = oursInsertsBefore.get(key) ?? [];
      arr.push(e.bi);
      oursInsertsBefore.set(key, arr);
    }
    if (e.op === "equal" || e.op === "delete") nextBase = e.ai + 1;
  }

  nextBase = 0;
  for (const e of tEdits) {
    if (e.op === "equal") {
      theirsMap[e.ai] = e.bi;
    } else if (e.op === "delete") {
      theirsMap[e.ai] = -1;
    } else {
      const key = nextBase;
      const arr = theirsInsertsBefore.get(key) ?? [];
      arr.push(e.bi);
      theirsInsertsBefore.set(key, arr);
    }
    if (e.op === "equal" || e.op === "delete") nextBase = e.ai + 1;
  }

  const output: string[] = [];
  let hasConflicts = false;

  /** Emit a conflict region. */
  function emitConflict(oursChunk: string[], theirsChunk: string[]) {
    if (oursChunk.join("\n") === theirsChunk.join("\n")) {
      // Both sides produced the same result — take it (clean).
      output.push(...oursChunk);
    } else {
      hasConflicts = true;
      output.push("<<<<<<< server");
      output.push(...oursChunk);
      output.push("=======");
      output.push(...theirsChunk);
      output.push(">>>>>>> client");
    }
  }

  for (let bi = 0; bi <= baseLines.length; bi++) {
    // Flush insertions before this base position
    const oInserts = oursInsertsBefore.get(bi) ?? [];
    const tInserts = theirsInsertsBefore.get(bi) ?? [];
    const oChunk = oInserts.map(idx => ourLines[idx]);
    const tChunk = tInserts.map(idx => theirLines[idx]);

    if (oChunk.length > 0 || tChunk.length > 0) {
      emitConflict(oChunk, tChunk);
    }

    if (bi >= baseLines.length) break;

    const om = oursMap[bi];   // -1 = deleted, >=0 = kept/replaced
    const tm = theirsMap[bi]; // same

    const oursKept   = om >= 0;
    const theirsKept = tm >= 0;

    if (oursKept && theirsKept) {
      // Both kept the base line — check if they produced the same output
      const oLine = ourLines[om];
      const tLine = theirLines[tm];
      if (oLine === tLine) {
        // Identical result (includes unchanged == baseLines[bi])
        output.push(oLine);
      } else {
        // Both changed the line to different values
        emitConflict([oLine], [tLine]);
      }
    } else if (!oursKept && !theirsKept) {
      // Both deleted — clean
    } else if (!oursKept && theirsKept) {
      // Only ours deleted → accept our deletion (drop the line)
    } else {
      // !theirsKept && oursKept → only theirs deleted → accept their deletion
    }
  }

  return { merged: output.join("\n"), hasConflicts };
}
