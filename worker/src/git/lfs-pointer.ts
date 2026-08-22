const LFS_VERSION = "https://git-lfs.github.com/spec/v1";
const POINTER_RE =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n?$/;

export interface LfsPointer {
  oid: string;
  size: number;
}

export function formatLfsPointer(pointer: LfsPointer): string {
  const oid = pointer.oid.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(oid)) {
    throw new Error("Invalid LFS object id");
  }
  if (!Number.isSafeInteger(pointer.size) || pointer.size < 0) {
    throw new Error("Invalid LFS object size");
  }
  return `version ${LFS_VERSION}\noid sha256:${oid}\nsize ${pointer.size}\n`;
}

export function parseLfsPointer(value: string | Uint8Array): LfsPointer | null {
  const text =
    typeof value === "string" ? value : new TextDecoder().decode(value);
  const match = POINTER_RE.exec(text);
  if (!match) return null;
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return { oid: match[1], size };
}

export function isLfsPointer(value: string | Uint8Array): boolean {
  return parseLfsPointer(value) !== null;
}
