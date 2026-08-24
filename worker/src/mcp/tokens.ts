const TOKEN_PREFIX = "lapis_";
const MAX_TOKENS_PER_USER = 20;
const MAX_NAME_LENGTH = 64;

export interface McpTokenRecord {
  id: string;
  userId: string;
  name: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedMcpToken extends McpTokenRecord {
  token: string;
}

interface McpTokenRow {
  id: string;
  user_id: string;
  name: string;
  last4: string;
  created_at: string;
  last_used_at: string | null;
}

function rowToRecord(row: McpTokenRow): McpTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    last4: row.last4,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function isMcpPersonalToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    TOKEN_PREFIX +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function normalizeName(name: string | undefined): string {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "MCP token";
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

export async function listMcpTokens(db: D1Database, userId: string): Promise<McpTokenRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, name, last4, created_at, last_used_at
       FROM mcp_tokens
       WHERE user_id = ? AND revoked = 0
       ORDER BY created_at DESC`
    )
    .bind(userId)
    .all<McpTokenRow>();
  return (results ?? []).map(rowToRecord);
}

export async function createMcpToken(
  db: D1Database,
  userId: string,
  name?: string
): Promise<CreatedMcpToken> {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND revoked = 0`)
    .bind(userId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS_PER_USER) {
    throw new Error("Token limit reached");
  }

  const token = generateToken();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record: CreatedMcpToken = {
    id,
    userId,
    name: normalizeName(name),
    last4: token.slice(-4),
    createdAt: now,
    lastUsedAt: null,
    token,
  };

  await db
    .prepare(
      `INSERT INTO mcp_tokens (id, user_id, name, token_hash, last4, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(record.id, userId, record.name, await hashToken(token), record.last4, now)
    .run();

  return record;
}

export async function revokeMcpToken(
  db: D1Database,
  userId: string,
  tokenId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE mcp_tokens SET revoked = 1
       WHERE id = ? AND user_id = ? AND revoked = 0`
    )
    .bind(tokenId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function resolveMcpBearerToken(
  db: D1Database,
  token: string
): Promise<McpTokenRecord | null> {
  if (!isMcpPersonalToken(token)) return null;
  const row = await db
    .prepare(
      `SELECT id, user_id, name, last4, created_at, last_used_at
       FROM mcp_tokens
       WHERE token_hash = ? AND revoked = 0`
    )
    .bind(await hashToken(token))
    .first<McpTokenRow>();
  return row ? rowToRecord(row) : null;
}

export async function touchMcpToken(db: D1Database, tokenId: string): Promise<void> {
  await db
    .prepare(`UPDATE mcp_tokens SET last_used_at = ? WHERE id = ? AND revoked = 0`)
    .bind(new Date().toISOString(), tokenId)
    .run();
}
