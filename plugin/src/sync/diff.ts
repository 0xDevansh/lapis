export function createPatch(path: string, original: string, modified: string): string {
  const originalLines = splitLines(original);
  const modifiedLines = splitLines(modified);
  const header = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${originalLines.length} +1,${modifiedLines.length} @@`];
  return [
    ...header,
    ...originalLines.map((line) => `-${line}`),
    ...modifiedLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function applyPatch(original: string, patch: string): string | null {
  const lines = patch.split("\n");
  const hunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  if (hunkIndex < 0) return null;
  const match = lines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;

  const source = original === "" ? [] : original.split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  const hunkStart = Number(match[1]) - 1;
  while (sourceIndex < hunkStart) {
    output.push(source[sourceIndex]);
    sourceIndex++;
  }

  for (const line of lines.slice(hunkIndex + 1)) {
    if (line === "") continue;
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      if (source[sourceIndex] !== content) return null;
      output.push(content);
      sourceIndex++;
    } else if (prefix === "-") {
      if (source[sourceIndex] !== content) return null;
      sourceIndex++;
    } else if (prefix === "+") {
      output.push(content);
    }
  }
  while (sourceIndex < source.length) {
    output.push(source[sourceIndex]);
    sourceIndex++;
  }
  return output.join("\n");
}

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  return value.replace(/\n$/, "").split("\n");
}
