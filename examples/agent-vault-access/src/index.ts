/**
 * Lapis Vault Agent — Project Think example
 *
 * A Think agent that authenticates to a Lapis server and gives an LLM
 * read access to a vault: list files, read notes, search, follow backlinks,
 * and explore tags.
 *
 * Quickstart:
 *   1. Copy .dev.vars.example to .dev.vars and fill in your values
 *   2. npm install
 *   3. npx wrangler dev
 *   4. Open http://localhost:5173 in your browser
 */

import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { z } from "zod";

export interface Env {
  AI: Ai;
  VaultAgent: DurableObjectNamespace;
  /** Base URL of your deployed Lapis server, e.g. https://lapis.example.workers.dev */
  LAPIS_URL: string;
  /** Agent device token (mint via POST /api/vaults/:id/agents) */
  LAPIS_AGENT_TOKEN: string;
  /** The vault ID to connect to (shown in the Lapis web app) */
  LAPIS_VAULT_ID: string;
}

// ── Vault Agent ─────────────────────────────────────────────────────────────

export class VaultAgent extends Think<Env> {
  // ── Sync API (agent device token) ─────────────────────────────────────────

  private async syncGet(path: string): Promise<Response> {
    return fetch(`${this.env.LAPIS_URL}${path}`, {
      headers: { Authorization: `Bearer ${this.env.LAPIS_AGENT_TOKEN}` },
    });
  }

  private async syncPut(path: string, body: BodyInit, contentType: string): Promise<Response> {
    return fetch(`${this.env.LAPIS_URL}${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.env.LAPIS_AGENT_TOKEN}`,
        "Content-Type": contentType,
      },
      body,
    });
  }

  // ── Read API (session-less; sync token works for manifest + file reads) ───

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
    );
  }

  getSystemPrompt() {
    return `You are a knowledgeable assistant with read access to a private Obsidian vault hosted on Lapis.

You have tools available:
- vault_list_files: list every file in the vault with path, size, and timestamps
- vault_read_file: read the full content of a specific note or attachment
- vault_search: full-text search across all notes with highlighted snippets
- vault_get_backlinks: find all notes that link to a given note via [[wikilinks]]
- vault_get_tags: list all tags used in the vault with occurrence counts
- vault_write_file: write or update a text file in the vault (agent-attributed; whole-file replace into the vault CRDT)

Use these tools to answer the user's questions about their vault content.
When reading notes, render wikilinks like [[Note Name]] as plain references to the target note.
If you need context from a linked note, use vault_read_file to fetch it.`;
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /** Agent devices authenticate with a Bearer sync token (Slice 24). */
  private async lapisGet(path: string): Promise<Response> {
    return this.syncGet(path);
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  getTools() {
    const vaultId = this.env.LAPIS_VAULT_ID;

    return {
      /**
       * List every file in the vault.
       * Returns an array of manifest entries with path, size, and revision.
       */
      vault_list_files: tool({
        description:
          "List all files in the vault. Returns each file's path, size in bytes, content type, and last-modified revision number.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await this.lapisGet(`/api/sync/${vaultId}/manifest`);
          if (!res.ok) {
            return { error: `Manifest request failed: ${res.status}` };
          }
          const manifest = (await res.json()) as {
            entries: Record<
              string,
              { path: string; size: number; contentType: string; revision: number }
            >;
          };
          const files = Object.values(manifest.entries);
          return {
            count: files.length,
            files: files.map(({ path, size, contentType, revision }) => ({
              path,
              size,
              contentType,
              revision,
            })),
          };
        },
      }),

      /**
       * Read a note or attachment by path.
       */
      vault_read_file: tool({
        description:
          "Read the full content of a file from the vault. For Markdown notes, returns the raw Markdown text. For binary files (images, PDFs), describes the file type and size instead.",
        inputSchema: z.object({
          path: z
            .string()
            .describe(
              "File path within the vault, e.g. 'notes/hello.md' or 'attachments/diagram.png'",
            ),
        }),
        execute: async ({ path }) => {
          // Encode each path segment separately to handle spaces and special chars
          const encodedPath = path
            .split("/")
            .map(encodeURIComponent)
            .join("/");

          const res = await this.lapisGet(
            `/api/sync/${vaultId}/files/${encodedPath}`,
          );

          if (res.status === 404) {
            return { error: `File not found: ${path}` };
          }
          if (!res.ok) {
            return { error: `Failed to read file (${res.status}): ${path}` };
          }

          const contentType = res.headers.get("content-type") ?? "";
          const revision = res.headers.get("x-revision") ?? "unknown";

          if (contentType.includes("text") || contentType.includes("json")) {
            const content = await res.text();
            return { path, revision, content };
          } else {
            // Binary file — describe it rather than returning raw bytes
            const sizeHeader = res.headers.get("content-length");
            return {
              path,
              revision,
              contentType,
              note: `Binary file (${sizeHeader ? `${sizeHeader} bytes` : "unknown size"}). Use vault_list_files to see metadata.`,
            };
          }
        },
      }),

      /**
       * Full-text search across all notes.
       */
      vault_search: tool({
        description:
          "Search the vault's notes by keyword. Returns up to 20 results ordered by relevance. Each result includes the file path and a highlighted snippet showing where the match appears. Matched terms are wrapped in ** markers.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("Search terms, e.g. 'project planning' or 'meeting notes'"),
        }),
        execute: async ({ query }) => {
          const res = await this.lapisGet(
            `/api/vaults/${vaultId}/search?q=${encodeURIComponent(query)}`,
          );
          if (!res.ok) {
            return { error: `Search failed: ${res.status}` };
          }
          const results = (await res.json()) as Array<{
            path: string;
            snippet: string;
          }>;
          return { query, count: results.length, results };
        },
      }),

      /**
       * Find notes that link to a given note.
       */
      vault_get_backlinks: tool({
        description:
          "Find all notes that contain a [[wikilink]] pointing to the given file. Useful for understanding how a note is connected to the rest of the vault.",
        inputSchema: z.object({
          path: z
            .string()
            .describe("Path of the note to find backlinks for, e.g. 'notes/hello.md'"),
        }),
        execute: async ({ path }) => {
          const res = await this.lapisGet(
            `/api/vaults/${vaultId}/backlinks?path=${encodeURIComponent(path)}`,
          );
          if (!res.ok) {
            return { error: `Backlinks request failed: ${res.status}` };
          }
          const results = (await res.json()) as Array<{ sourcePath: string }>;
          return {
            target: path,
            count: results.length,
            sources: results.map((r) => r.sourcePath),
          };
        },
      }),

      /**
       * List all tags used in the vault.
       */
      vault_get_tags: tool({
        description:
          "List all #tags used across the vault, ordered by how often they appear. Useful for understanding the vault's topic structure.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await this.lapisGet(`/api/vaults/${vaultId}/tags`);
          if (!res.ok) {
            return { error: `Tags request failed: ${res.status}` };
          }
          const tags = (await res.json()) as Array<{
            tag: string;
            count: number;
          }>;
          return { count: tags.length, tags };
        },
      }),

      vault_write_file: tool({
        description:
          "Write or replace a text file in the vault. Content is stored in the vault CRDT (Yjs).",
        inputSchema: z.object({
          path: z.string().describe("Vault-relative path, e.g. 'notes/summary.md'"),
          content: z.string().describe("Full file content"),
        }),
        execute: async ({ path, content }) => {
          const encodedPath = path.split("/").map(encodeURIComponent).join("/");
          const res = await this.syncPut(
            `/api/sync/${vaultId}/files/${encodedPath}`,
            new TextEncoder().encode(content),
            "text/markdown",
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            return { error: body.error ?? `Write failed (${res.status})` };
          }
          const entry = await res.json() as { path: string };
          return { path: entry.path ?? path, ok: true };
        },
      }),
    };
  }
}

// ── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
