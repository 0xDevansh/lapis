import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Env } from "../types";
import { isTextContentType } from "../vault/contracts";
import { contentTypeForUpload } from "../vault/mime";
import { isValidSyncPath, isVaultInternal } from "../vault/path";
import { createPatch } from "../vault/patch";
import { roleCanWrite } from "../vault/access";

const DEFAULT_LIMIT = 100;

interface McpPolicy {
  vaultId: string;
  vaultName: string;
  ownerId: string;
  role: "owner" | "editor" | "viewer";
  enabled: boolean;
  mode: "read-only" | "read-write";
  allowGrep: boolean;
  allowDelete: boolean;
  allowInternals: boolean;
  pathAllow: string[];
  pathDeny: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
  maxResults: number;
}

interface ToolContext {
  env: Env;
  userId: string;
  clientId: string;
}

type AccessTokenClaims = Record<string, unknown> & {
  sub?: unknown;
  client_id?: unknown;
};

const optionalVault = z.string().optional().describe("Vault id or exact vault name.");
const pathArg = z.string().describe("Vault-relative path.");

function textResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function err(message: string): never {
  throw new Error(message);
}

function parseJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(path));
}

function checkPath(policy: McpPolicy, path: string): void {
  if (!isValidSyncPath(path, policy.allowInternals)) err("Invalid path");
  if (isVaultInternal(path) && !policy.allowInternals) err("Vault internals are not enabled for MCP");
  if (policy.pathAllow.length > 0 && !matchesAny(path, policy.pathAllow)) {
    err("Path is outside the MCP allow list");
  }
  if (matchesAny(path, policy.pathDeny)) err("Path is denied by MCP policy");
}

function checkWritable(policy: McpPolicy, operation: string): void {
  if (!roleCanWrite(policy.role)) err(`${operation} is not allowed for ${policy.role}s`);
  if (policy.mode !== "read-write") err(`${operation} requires read/write MCP mode`);
}

function stubFor(env: Env, vaultId: string) {
  return env.VAULT_COORDINATOR.get(env.VAULT_COORDINATOR.idFromName(vaultId));
}

async function policiesForUser(env: Env, userId: string): Promise<McpPolicy[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.vault_id AS vaultId, v.name AS vaultName, p.owner_id AS ownerId,
            m.role AS memberRole,
            p.enabled, p.mode, p.allow_grep AS allowGrep,
            p.allow_delete AS allowDelete, p.allow_internals AS allowInternals,
            p.path_allow AS pathAllow, p.path_deny AS pathDeny,
            p.max_read_bytes AS maxReadBytes, p.max_write_bytes AS maxWriteBytes,
            p.max_results AS maxResults
     FROM vault_mcp_policies p
     JOIN vaults v ON v.id = p.vault_id
     JOIN vault_members m ON m.vault_id = v.id
     WHERE m.user_id = ? AND p.enabled = 1 AND v.archived_at IS NULL
     ORDER BY v.created_at DESC`
  )
    .bind(userId)
    .all<{
      vaultId: string;
      vaultName: string;
      ownerId: string;
      memberRole: string;
      enabled: number;
      mode: string;
      allowGrep: number;
      allowDelete: number;
      allowInternals: number;
      pathAllow: string | null;
      pathDeny: string | null;
      maxReadBytes: number;
      maxWriteBytes: number;
      maxResults: number;
    }>();

  return (results ?? []).map((row) => {
    const role =
      row.memberRole === "owner" || row.memberRole === "editor" || row.memberRole === "viewer"
        ? row.memberRole
        : "viewer";
    const viewer = !roleCanWrite(role);
    return {
      vaultId: row.vaultId,
      vaultName: row.vaultName,
      ownerId: row.ownerId,
      role,
      enabled: Boolean(row.enabled),
      mode: viewer ? "read-only" : row.mode === "read-write" ? "read-write" : "read-only",
      allowGrep: Boolean(row.allowGrep),
      allowDelete: viewer ? false : Boolean(row.allowDelete),
      allowInternals: Boolean(row.allowInternals),
      pathAllow: parseJsonList(row.pathAllow),
      pathDeny: parseJsonList(row.pathDeny),
      maxReadBytes: row.maxReadBytes,
      maxWriteBytes: row.maxWriteBytes,
      maxResults: row.maxResults,
    };
  });
}

async function resolvePolicy(
  ctx: ToolContext,
  vault?: string
): Promise<McpPolicy> {
  const policies = await policiesForUser(ctx.env, ctx.userId);
  if (policies.length === 0) err("No active vaults are enabled for MCP");
  if (!vault) {
    if (policies.length === 1) return policies[0];
    err("vault is required because multiple vaults are enabled for MCP");
  }
  const match = policies.find((policy) => policy.vaultId === vault || policy.vaultName === vault);
  if (!match) err("Vault is not enabled for MCP or is archived");
  return match;
}

function decodeText(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

function lineNumbered(text: string, offset = 1, limit = 400) {
  const lines = text.split("\n");
  const start = Math.max(1, offset);
  const end = Math.min(lines.length, start + Math.max(1, limit) - 1);
  const body = lines.slice(start - 1, end).map((line, index) => `${start + index}|${line}`);
  return {
    text: body.join("\n"),
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated: end < lines.length,
  };
}

export function createLapisMcpHandler(env: Env, claims: AccessTokenClaims) {
  const userId = String(claims.sub ?? "");
  const clientId = String(claims.client_id ?? "unknown-client");
  const toolContext: ToolContext = { env, userId, clientId };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "lapis", version: "0.1.0" });

      server.registerTool("list_vaults", {
        description: "List active Lapis vaults enabled for this MCP client.",
        inputSchema: z.object({}),
      }, async () => {
        const policies = await policiesForUser(env, userId);
        return textResult(policies.map((policy) => ({
          id: policy.vaultId,
          name: policy.vaultName,
          role: policy.role,
          mode: policy.mode,
          allowGrep: policy.allowGrep,
          allowDelete: policy.allowDelete,
          allowInternals: policy.allowInternals,
        })));
      });

      server.registerTool("read", {
        description: "Read a vault text file with stable line numbers and truncation metadata.",
        inputSchema: z.object({
          vault: optionalVault,
          path: pathArg,
          offset: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(2000).optional(),
        }),
      }, async ({ vault, path, offset, limit }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkPath(policy, path);
        const content = await stubFor(env, policy.vaultId).getContent(policy.vaultId, path);
        if (!content) err("File not found");
        if (!isTextContentType(content.contentType)) {
          return textResult({
            path: content.path,
            contentType: content.contentType,
            revision: content.revision,
            size: content.bytes.byteLength,
            binary: true,
          });
        }
        if (content.bytes.byteLength > policy.maxReadBytes) {
          err(`File exceeds MCP read limit of ${policy.maxReadBytes} bytes`);
        }
        const numbered = lineNumbered(decodeText(content.bytes), offset, limit);
        return textResult({
          path: content.path,
          revision: content.revision,
          contentType: content.contentType,
          ...numbered,
        });
      });

      server.registerTool("write", {
        description: "Create or fully replace a text file. Existing files require baseRevision.",
        inputSchema: z.object({
          vault: optionalVault,
          path: pathArg,
          content: z.string(),
          baseRevision: z.number().int().nonnegative().optional(),
        }),
      }, async ({ vault, path, content, baseRevision }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "write");
        checkPath(policy, path);
        const bytes = new TextEncoder().encode(content);
        if (bytes.byteLength > policy.maxWriteBytes) {
          err(`Content exceeds MCP write limit of ${policy.maxWriteBytes} bytes`);
        }
        const manifest = await stubFor(env, policy.vaultId).getManifest(policy.vaultId);
        const existing = manifest.entries[path.toLowerCase()];
        if (existing && baseRevision === undefined) {
          err("baseRevision is required when replacing an existing file");
        }
        const entry = await stubFor(env, policy.vaultId).syncPutFile(
          policy.vaultId,
          path,
          bytes.buffer as ArrayBuffer,
          contentTypeForUpload(path, "text/plain"),
          baseRevision,
          `mcp:${clientId}`,
          "conflict-note",
          policy.allowInternals
        );
        return textResult({ ok: true, entry });
      });

      server.registerTool("edit", {
        description: "Apply an exact old_string to new_string replacement to one text file.",
        inputSchema: z.object({
          vault: optionalVault,
          path: pathArg,
          old_string: z.string(),
          new_string: z.string(),
          baseRevision: z.number().int().nonnegative(),
          replace_all: z.boolean().optional(),
        }),
      }, async ({ vault, path, old_string, new_string, baseRevision, replace_all }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "edit");
        checkPath(policy, path);
        const content = await stubFor(env, policy.vaultId).getContent(policy.vaultId, path);
        if (!content) err("File not found");
        if (!isTextContentType(content.contentType)) err("edit only supports text files");
        const original = decodeText(content.bytes);
        const matches = old_string === "" ? 0 : original.split(old_string).length - 1;
        if (matches === 0) err("old_string was not found");
        if (matches > 1 && !replace_all) err("old_string is not unique; set replace_all to true");
        const updated = replace_all
          ? original.split(old_string).join(new_string)
          : original.replace(old_string, new_string);
        const patch = createPatch(path, original, updated, baseRevision);
        const entry = await stubFor(env, policy.vaultId).syncApplyPatch(
          policy.vaultId,
          path,
          patch,
          baseRevision,
          `mcp:${clientId}`,
          "conflict-note",
          policy.allowInternals
        );
        return textResult({ ok: true, entry });
      });

      server.registerTool("apply_patch", {
        description: "Apply a unified diff to a text file using revision-aware conflict checks.",
        inputSchema: z.object({
          vault: optionalVault,
          path: pathArg,
          patch: z.string(),
          baseRevision: z.number().int().nonnegative(),
        }),
      }, async ({ vault, path, patch, baseRevision }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "apply_patch");
        checkPath(policy, path);
        const entry = await stubFor(env, policy.vaultId).syncApplyPatch(
          policy.vaultId,
          path,
          patch,
          baseRevision,
          `mcp:${clientId}`,
          "conflict-note",
          policy.allowInternals
        );
        return textResult({ ok: true, entry });
      });

      server.registerTool("grep", {
        description: "Search text file contents by regex or literal pattern. Returns paths and line numbers.",
        inputSchema: z.object({
          vault: optionalVault,
          pattern: z.string(),
          path: z.string().optional(),
          glob: z.string().optional(),
          ignoreCase: z.boolean().optional(),
          literal: z.boolean().optional(),
          context: z.number().int().min(0).max(10).optional(),
          limit: z.number().int().positive().max(1000).optional(),
          offset: z.number().int().min(0).optional(),
        }),
      }, async (args) => {
        const policy = await resolvePolicy(toolContext, args.vault);
        if (!policy.allowGrep) err("grep is disabled by MCP policy");
        const limit = Math.min(args.limit ?? DEFAULT_LIMIT, policy.maxResults);
        const offset = args.offset ?? 0;
        const matcher = args.literal
          ? (line: string) => args.ignoreCase
            ? line.toLowerCase().includes(args.pattern.toLowerCase())
            : line.includes(args.pattern)
          : (line: string) => new RegExp(args.pattern, args.ignoreCase ? "i" : "").test(line);
        const pathPrefix = args.path?.replace(/\/+$/, "");
        const globMatcher = args.glob ? wildcardToRegExp(args.glob) : null;
        const manifest = await stubFor(env, policy.vaultId).getManifest(policy.vaultId);
        const matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }> = [];
        for (const entry of Object.values(manifest.entries)) {
          if (!isTextContentType(entry.contentType)) continue;
          if (pathPrefix && entry.path !== pathPrefix && !entry.path.startsWith(`${pathPrefix}/`)) continue;
          if (globMatcher && !globMatcher.test(entry.path)) continue;
          try {
            checkPath(policy, entry.path);
          } catch {
            continue;
          }
          const content = await stubFor(env, policy.vaultId).getContent(policy.vaultId, entry.path);
          if (!content) continue;
          const lines = decodeText(content.bytes).split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!matcher(lines[i])) continue;
            const radius = args.context ?? 0;
            matches.push({
              path: entry.path,
              line: i + 1,
              text: lines[i],
              before: radius ? lines.slice(Math.max(0, i - radius), i) : undefined,
              after: radius ? lines.slice(i + 1, i + 1 + radius) : undefined,
            });
          }
        }
        return textResult({
          matches: matches.slice(offset, offset + limit),
          totalMatches: matches.length,
          offset,
          limit,
          truncated: offset + limit < matches.length,
        });
      });

      server.registerTool("find", {
        description: "Find vault file paths by glob-style pattern over the manifest.",
        inputSchema: z.object({
          vault: optionalVault,
          pattern: z.string(),
          limit: z.number().int().positive().max(1000).optional(),
          offset: z.number().int().min(0).optional(),
        }),
      }, async ({ vault, pattern, limit, offset }) => {
        const policy = await resolvePolicy(toolContext, vault);
        const max = Math.min(limit ?? policy.maxResults, policy.maxResults);
        const start = offset ?? 0;
        const matcher = wildcardToRegExp(pattern);
        const manifest = await stubFor(env, policy.vaultId).getManifest(policy.vaultId);
        const paths = Object.values(manifest.entries)
          .map((entry) => entry.path)
          .filter((path) => {
            try {
              checkPath(policy, path);
              return matcher.test(path);
            } catch {
              return false;
            }
          })
          .sort();
        return textResult({
          paths: paths.slice(start, start + max),
          totalMatches: paths.length,
          offset: start,
          limit: max,
          truncated: start + max < paths.length,
        });
      });

      server.registerTool("ls", {
        description: "List immediate or bounded-depth vault directory entries with metadata.",
        inputSchema: z.object({
          vault: optionalVault,
          path: z.string().optional(),
          depth: z.number().int().min(1).max(5).optional(),
          limit: z.number().int().positive().max(1000).optional(),
        }),
      }, async ({ vault, path = "", depth = 1, limit }) => {
        const policy = await resolvePolicy(toolContext, vault);
        const dir = path.replace(/^\/+|\/+$/g, "");
        if (dir) checkPath(policy, dir);
        const max = Math.min(limit ?? policy.maxResults, policy.maxResults);
        const manifest = await stubFor(env, policy.vaultId).getManifest(policy.vaultId);
        const entries = new Map<string, Record<string, unknown>>();
        for (const entry of Object.values(manifest.entries)) {
          try {
            checkPath(policy, entry.path);
          } catch {
            continue;
          }
          const relative = dir
            ? entry.path.startsWith(`${dir}/`) ? entry.path.slice(dir.length + 1) : null
            : entry.path;
          if (!relative) continue;
          const parts = relative.split("/");
          if (parts.length > depth) {
            entries.set(`${dir ? `${dir}/` : ""}${parts.slice(0, depth).join("/")}/`, {
              path: `${dir ? `${dir}/` : ""}${parts.slice(0, depth).join("/")}/`,
              type: "directory",
            });
          } else {
            entries.set(entry.path, {
              path: entry.path,
              type: "file",
              size: entry.size,
              contentType: entry.contentType,
              revision: entry.revision,
              updatedAt: entry.updatedAt,
            });
          }
        }
        const result = [...entries.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
        return textResult({
          entries: result.slice(0, max),
          totalEntries: result.length,
          truncated: result.length > max,
        });
      });

      server.registerTool("stat", {
        description: "Return type, size, revision, and modified time for one path.",
        inputSchema: z.object({ vault: optionalVault, path: pathArg }),
      }, async ({ vault, path }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkPath(policy, path);
        const manifest = await stubFor(env, policy.vaultId).getManifest(policy.vaultId);
        const entry = manifest.entries[path.toLowerCase()];
        if (!entry) err("Path not found");
        return textResult({
          path: entry.path,
          type: "file",
          size: entry.size,
          contentType: entry.contentType,
          revision: entry.revision,
          updatedAt: entry.updatedAt,
        });
      });

      server.registerTool("mv", {
        description: "Move or rename a file.",
        inputSchema: z.object({ vault: optionalVault, oldPath: pathArg, newPath: pathArg }),
      }, async ({ vault, oldPath, newPath }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "mv");
        checkPath(policy, oldPath);
        checkPath(policy, newPath);
        const entry = await stubFor(env, policy.vaultId).syncRenameFile(
          policy.vaultId,
          oldPath,
          newPath,
          `mcp:${clientId}`,
          policy.allowInternals
        );
        return textResult({ ok: true, entry });
      });

      server.registerTool("rm", {
        description: "Delete a file. Disabled by default in MCP policy.",
        inputSchema: z.object({ vault: optionalVault, path: pathArg }),
      }, async ({ vault, path }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "rm");
        if (!policy.allowDelete) err("rm is disabled by MCP policy");
        checkPath(policy, path);
        await stubFor(env, policy.vaultId).syncDeleteFile(
          policy.vaultId,
          path,
          `mcp:${clientId}`,
          policy.allowInternals
        );
        return textResult({ ok: true, path });
      });

      server.registerTool("mkdir", {
        description: "Create a virtual folder by writing an empty .keep marker.",
        inputSchema: z.object({ vault: optionalVault, path: pathArg }),
      }, async ({ vault, path }) => {
        const policy = await resolvePolicy(toolContext, vault);
        checkWritable(policy, "mkdir");
        const folder = path.replace(/^\/+|\/+$/g, "");
        checkPath(policy, `${folder}/.keep`);
        const entry = await stubFor(env, policy.vaultId).syncPutFile(
          policy.vaultId,
          `${folder}/.keep`,
          new ArrayBuffer(0),
          "text/plain",
          undefined,
          `mcp:${clientId}`,
          "conflict-note",
          policy.allowInternals
        );
        return textResult({ ok: true, entry });
      });

      return server;
    },
    { legacy: "stateless" }
  );
  return handler;
}
