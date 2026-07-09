/**
 * Canonical device identity strings — Slice 21.
 *
 * Every sync peer is identified as `${kind}:${id}` for authorship, presence,
 * and self-echo filtering.
 */

export type DeviceKind = "plugin" | "web" | "agent" | "github";

/** Produce the canonical author / presence identity string. */
export function deviceAuthor(kind: DeviceKind, id: string): string {
  return `${kind}:${id}`;
}

/** Parse a canonical identity back into kind and id. */
export function parseDeviceAuthor(identity: string): { kind: DeviceKind; id: string } | null {
  const idx = identity.indexOf(":");
  if (idx <= 0) return null;
  const kind = identity.slice(0, idx) as DeviceKind;
  const id = identity.slice(idx + 1);
  if (!id) return null;
  return { kind, id };
}
