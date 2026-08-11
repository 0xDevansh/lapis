/**
 * Vault role statements for better-auth access control (ADR 0009).
 * Used without the organization plugin — roles live in vault_members.
 */
import { createAccessControl } from "better-auth/plugins/access";

export const vaultStatements = {
  vault: ["read", "write", "delete"],
  member: ["read", "create", "update", "delete"],
  invitation: ["create", "cancel"],
  device: ["create", "approve", "revoke"],
  git: ["read", "write"],
} as const;

export const ac = createAccessControl(vaultStatements);

export const ownerRole = ac.newRole({
  vault: ["read", "write", "delete"],
  member: ["read", "create", "update", "delete"],
  invitation: ["create", "cancel"],
  device: ["create", "approve", "revoke"],
  git: ["read", "write"],
});

export const editorRole = ac.newRole({
  vault: ["read", "write"],
  member: ["read"],
  invitation: [],
  device: ["create", "approve"],
  git: ["read"],
});

export const viewerRole = ac.newRole({
  vault: ["read"],
  member: ["read"],
  invitation: [],
  device: [],
  git: [],
});

export type VaultRole = "owner" | "editor" | "viewer";

export const roles = {
  owner: ownerRole,
  editor: editorRole,
  viewer: viewerRole,
} as const;

export type VaultPermission =
  | { vault: "read" | "write" | "delete" }
  | { member: "read" | "create" | "update" | "delete" }
  | { invitation: "create" | "cancel" }
  | { device: "create" | "approve" | "revoke" }
  | { git: "read" | "write" };

export function roleHasPermission(role: VaultRole, permission: VaultPermission): boolean {
  const key = Object.keys(permission)[0] as keyof VaultPermission;
  const action = (permission as Record<string, string>)[key];
  const allowed: Record<VaultRole, Record<string, string[]>> = {
    owner: {
      vault: ["read", "write", "delete"],
      member: ["read", "create", "update", "delete"],
      invitation: ["create", "cancel"],
      device: ["create", "approve", "revoke"],
      git: ["read", "write"],
    },
    editor: {
      vault: ["read", "write"],
      member: ["read"],
      invitation: [],
      device: ["create", "approve"],
      git: ["read"],
    },
    viewer: {
      vault: ["read"],
      member: ["read"],
      invitation: [],
      device: [],
      git: [],
    },
  };
  return allowed[role][key]?.includes(action) ?? false;
}

export function canWriteContent(role: VaultRole): boolean {
  return roleHasPermission(role, { vault: "write" });
}
