/** Canonical device identity — mirrors worker/src/vault/identity.ts (Slice 21). */

export type DeviceKind = "plugin" | "web" | "agent" | "github";

export function deviceAuthor(kind: DeviceKind, id: string): string {
  return `${kind}:${id}`;
}
