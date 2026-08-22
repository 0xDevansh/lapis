const MIME_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  json: "application/json",
  canvas: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export function detectMimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function contentTypeForUpload(
  path: string,
  declaredContentType?: string
): string {
  const inferred = detectMimeFromPath(path);
  if (inferred !== "application/octet-stream") return inferred;
  return (
    declaredContentType?.split(";")[0].trim() || "application/octet-stream"
  );
}
