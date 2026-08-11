/**
 * Stateless Lapis vault MCP server (Yjs-backed via VaultCoordinator).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "../types";
import { getDeviceByToken } from "../devices/record";
import { identityFromRecord } from "../devices/types";
import {
  assertPathAccess,
  getMcpSettings,
  normalizeVaultPath,
  type VaultMcpSettings,
} from "./settings";

export interface McpSessionProps {
  vaultId: string;
  deviceId: string;
  author: string;
  settings: VaultMcpSettings;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function stubFor(env: Env, vaultId: string) {
  return env.VAULT_COORDINATOR.get(env.VAULT_COORDINATOR.idFromName(vaultId));
}

function propsFromContext(): McpSessionProps {
  const ctx = getMcpAuthContext();
  const props = ctx?.props as McpSessionProps | undefined;
  if (!props?.vaultId || !props.settings) {
    throw new Error("MCP session not authenticated");
  }
  return props;
}

function sanitizeFtsQuery(q: string): string {
  const cleaned = q.replace(/[^a-zA-Z0-9_\-\s./]/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

export function createVaultMcpServer(env: Env) {
  const server = new McpServer({
    name: "lapis-vault",
    version: "1.0.0",
  });

  server.registerTool(
    "list_files",
    {
      description:
        "List active files in the Lapis vault (derived from the Yjs CRDT document).",
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe("Optional path prefix filter, e.g. notes/"),
      },
    },
    async ({ prefix }) => {
      const { vaultId, settings } = propsFromContext();
      const manifest = await stubFor(env, vaultId).getManifest(vaultId);
      const pref = prefix ? normalizeVaultPath(prefix).toLowerCase() : "";
      const files = Object.values(manifest.entries)
        .filter((e) => {
          if (pref && !normalizeVaultPath(e.path).toLowerCase().startsWith(pref)) return false;
          try {
            assertPathAccess(e.path, settings, "list");
            return true;
          } catch {
            return false;
          }
        })
        .map((e) => ({
          path: e.path,
          size: e.size,
          contentType: e.contentType,
          updatedAt: e.updatedAt,
        }));
      return textResult(JSON.stringify({ count: files.length, files }, null, 2));
    }
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a text note from the vault CRDT (or binary metadata).",
      inputSchema: {
        path: z.string().describe("Vault-relative path"),
      },
    },
    async ({ path }) => {
      const { vaultId, settings } = propsFromContext();
      const filePath = normalizeVaultPath(path);
      assertPathAccess(filePath, settings, "read");
      const content = await stubFor(env, vaultId).getContent(vaultId, filePath);
      if (!content) return textResult(`Not found: ${filePath}`, true);
      if (content.bytes.byteLength > settings.maxReadBytes) {
        return textResult(
          `File exceeds maxReadBytes (${settings.maxReadBytes}). Size=${content.bytes.byteLength}`,
          true
        );
      }
      const isText =
        content.contentType.startsWith("text/") ||
        content.contentType.includes("json") ||
        content.contentType.includes("xml") ||
        filePath.toLowerCase().endsWith(".md");
      if (!isText) {
        return textResult(
          JSON.stringify({
            path: content.path,
            contentType: content.contentType,
            size: content.bytes.byteLength,
            note: "Binary file — content not inlined. Use list_files / download via sync API.",
          })
        );
      }
      const text = new TextDecoder().decode(content.bytes);
      return textResult(text);
    }
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Create or replace a text file in the vault CRDT (whole-file write into Yjs).",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        contentType: z.string().optional().describe("Defaults to text/markdown"),
      },
    },
    async ({ path, content, contentType }) => {
      const { vaultId, author, settings } = propsFromContext();
      if (settings.readOnly || !settings.allowWrite) {
        return textResult("MCP writes are disabled for this vault", true);
      }
      const filePath = normalizeVaultPath(path);
      assertPathAccess(filePath, settings, "write");
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > settings.maxReadBytes) {
        return textResult(`Content exceeds maxReadBytes (${settings.maxReadBytes})`, true);
      }
      const entry = await stubFor(env, vaultId).syncPutFile(
        vaultId,
        filePath,
        bytes.buffer as ArrayBuffer,
        contentType ?? "text/markdown",
        author
      );
      return textResult(JSON.stringify({ ok: true, path: entry.path, size: entry.size }));
    }
  );

  server.registerTool(
    "delete_file",
    {
      description: "Soft-delete a file in the vault CRDT.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const { vaultId, author, settings } = propsFromContext();
      if (settings.readOnly || !settings.allowDelete) {
        return textResult("MCP deletes are disabled for this vault", true);
      }
      const filePath = normalizeVaultPath(path);
      assertPathAccess(filePath, settings, "delete");
      await stubFor(env, vaultId).syncDeleteFile(vaultId, filePath, author);
      return textResult(JSON.stringify({ ok: true, path: filePath }));
    }
  );

  server.registerTool(
    "search",
    {
      description: "Full-text search across indexed vault notes.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const { vaultId, settings } = propsFromContext();
      if (!settings.allowSearch) {
        return textResult("MCP search is disabled for this vault", true);
      }
      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) return textResult(JSON.stringify({ results: [] }));

      const { results } = await env.DB.prepare(
        `SELECT path, snippet(vault_fts, 3, '**', '**', '…', 32) AS snippet
         FROM vault_fts
         WHERE vault_id = ? AND vault_fts MATCH ?
         ORDER BY bm25(vault_fts, 0, 0, 1, 10)
         LIMIT 20`
      )
        .bind(vaultId, safeQuery)
        .all<{ path: string; snippet: string }>();

      const filtered = (results ?? []).filter((r) => {
        try {
          assertPathAccess(r.path, settings, "search");
          return true;
        } catch {
          return false;
        }
      });
      return textResult(JSON.stringify({ results: filtered }, null, 2));
    }
  );

  return server;
}

function extractBearer(request: Request): string {
  const auth = request.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(request.url);
  return url.searchParams.get("token")?.trim() ?? "";
}

/**
 * Authenticate + enforce MCP enabled, then hand off to createMcpHandler.
 * URL: /api/mcp/:vaultId
 */
export async function handleVaultMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // api / mcp / :vaultId
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "mcp") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const vaultId = parts[2];
  const route = `/api/mcp/${vaultId}`;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const token = extractBearer(request);
  if (!token) {
    return Response.json({ error: "Unauthorized — Bearer MCP/agent token required" }, { status: 401 });
  }

  const record = await getDeviceByToken(env.DB, token);
  if (!record || record.vaultId !== vaultId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getMcpSettings(env.DB, vaultId);
  if (!settings.enabled) {
    return Response.json(
      { error: "MCP is disabled for this vault. Enable it in vault settings." },
      { status: 403 }
    );
  }

  env.DB.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), record.id)
    .run()
    .catch(() => {});

  const identity = identityFromRecord(record);
  const props: McpSessionProps = {
    vaultId,
    deviceId: record.id,
    author: identity.author,
    settings,
  };

  const handler = createMcpHandler(() => createVaultMcpServer(env), {
    route,
    allowedOriginHostnames: "*",
    allowedHostnames: [url.hostname],
    authContext: { props: { ...props } },
    corsOptions: {
      origin: "*",
      methods: "GET, POST, DELETE, OPTIONS",
      headers: "Authorization, Content-Type, Accept, Mcp-Session-Id",
    },
  });

  return handler(request, env, ctx);
}
