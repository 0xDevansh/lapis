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

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  return value.replace(/\n$/, "").split("\n");
}
