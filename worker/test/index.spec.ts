import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import worker from "../src/index";
import { applyPatch, createPatch, merge3 } from "../src/vault/patch";
import { deviceAuthor } from "../src/vault/identity";
import {
	conflictNotePath,
	parseConflictNoteMetadata,
	renderConflictNote,
} from "../src/vault/conflict";
import { encryptPat, decryptPat, patLast4 } from "../src/git/crypto";
import { isValidSyncPath } from "../src/vault/path";
import { contentTypeForUpload } from "../src/vault/mime";
import { createLapisMcpHandler } from "../src/mcp/server";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const authEnv = {
	...env,
	BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
	BETTER_AUTH_URL: "http://example.com",
};

class CookieJar {
	private readonly values = new Map<string, string>();

	apply(response: Response) {
		const header = response.headers.get("set-cookie");
		if (!header) return;

		for (const cookie of header.split(/,(?=\s*[^;,]+=)/)) {
			const [pair] = cookie.trim().split(";", 1);
			const separator = pair.indexOf("=");
			const name = pair.slice(0, separator);
			const value = pair.slice(separator + 1);
			if (/max-age=0/i.test(cookie) || value === "") this.values.delete(name);
			else this.values.set(name, value);
		}
	}

	toHeader(): string {
		return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

async function authRequest(
	path: string,
	init: RequestInit = {},
	jar?: CookieJar
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Origin", "http://example.com");
	if (init.body) headers.set("Content-Type", "application/json");
	if (jar?.toHeader()) headers.set("Cookie", jar.toHeader());

	const request = new IncomingRequest(`http://example.com/api/auth${path}`, {
		...init,
		headers,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv, ctx);
	await waitOnExecutionContext(ctx);
	jar?.apply(response);
	return response;
}

async function apiRequest(
	path: string,
	init: RequestInit = {},
	jar?: CookieJar
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Origin", "http://example.com");
	if (init.body) headers.set("Content-Type", "application/json");
	if (jar?.toHeader()) headers.set("Cookie", jar.toHeader());

	const request = new IncomingRequest(`http://example.com${path}`, {
		...init,
		headers,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv, ctx);
	await waitOnExecutionContext(ctx);
	jar?.apply(response);
	return response;
}

async function signUpJar(emailPrefix: string): Promise<CookieJar> {
	const { jar } = await signUpAccount(emailPrefix);
	return jar;
}

async function signUpAccount(emailPrefix: string): Promise<{
	jar: CookieJar;
	email: string;
	userId: string;
}> {
	const jar = new CookieJar();
	const email = `${emailPrefix}-${crypto.randomUUID()}@example.com`;
	const response = await authRequest(
		"/sign-up/email",
		{
			method: "POST",
			body: JSON.stringify({
				name: "Test User",
				email,
				password: "correct-horse-battery",
			}),
		},
		jar
	);
	expect(response.status).toBe(200);
	const session = await (
		await authRequest("/get-session", {}, jar)
	).json<{ user: { id: string; email: string } }>();
	return { jar, email: session.user.email, userId: session.user.id };
}

describe("Lapis worker", () => {
	beforeAll(async () => {
		await env.DB.batch([
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES "user"(id))'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, issuer TEXT, userId TEXT NOT NULL REFERENCES "user"(id), accessToken TEXT, refreshToken TEXT, idToken TEXT, expiresAt TEXT, accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT)'),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS jwks (id TEXT PRIMARY KEY, publicKey TEXT NOT NULL, privateKey TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT, alg TEXT, crv TEXT)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS oauthAccessToken (id TEXT PRIMARY KEY, token TEXT UNIQUE, clientId TEXT NOT NULL, sessionId TEXT, userId TEXT, referenceId TEXT, authorizationCodeId TEXT, resources TEXT, requestedUserInfoClaims TEXT, refreshId TEXT, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, revoked TEXT, confirmation TEXT, scopes TEXT NOT NULL)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS oauthRefreshToken (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, clientId TEXT NOT NULL, sessionId TEXT, userId TEXT NOT NULL, referenceId TEXT, authorizationCodeId TEXT, resources TEXT, requestedUserInfoClaims TEXT, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, revoked TEXT, rotatedAt TEXT, rotationReplayResponse TEXT, rotationReplayExpiresAt TEXT, authTime TEXT, confirmation TEXT, scopes TEXT NOT NULL)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS vault_mcp_policies (vault_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'read-only', allow_grep INTEGER NOT NULL DEFAULT 1, allow_delete INTEGER NOT NULL DEFAULT 0, allow_internals INTEGER NOT NULL DEFAULT 0, path_allow TEXT, path_deny TEXT, max_read_bytes INTEGER NOT NULL DEFAULT 131072, max_write_bytes INTEGER NOT NULL DEFAULT 131072, max_results INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
			env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauthClient (
        id TEXT PRIMARY KEY, clientId TEXT NOT NULL UNIQUE, clientSecret TEXT, clientDiscoveryId TEXT,
        disabled INTEGER DEFAULT 0, skipConsent INTEGER, enableEndSession INTEGER, subjectType TEXT,
        scopes TEXT, clientCredentialsScopes TEXT, userId TEXT, createdAt TEXT, updatedAt TEXT, name TEXT,
        uri TEXT, icon TEXT, contacts TEXT, tos TEXT, policy TEXT, softwareId TEXT, softwareVersion TEXT,
        softwareStatement TEXT, redirectUris TEXT NOT NULL, postLogoutRedirectUris TEXT,
        backchannelLogoutUri TEXT, backchannelLogoutSessionRequired INTEGER, tokenEndpointAuthMethod TEXT,
        applicationType TEXT, jwks TEXT, jwksUri TEXT, grantTypes TEXT, responseTypes TEXT,
        requirePKCE INTEGER, dpopBoundAccessTokens INTEGER DEFAULT 0, referenceId TEXT, metadata TEXT
      )`),
			env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauthResource (
        id TEXT PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        accessTokenTtl INTEGER, refreshTokenTtl INTEGER, signingAlgorithm TEXT, signingKeyId TEXT,
        allowedScopes TEXT, customClaims TEXT, dpopBoundAccessTokensRequired INTEGER DEFAULT 0,
        disabled INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT, policyVersion INTEGER DEFAULT 1, metadata TEXT
      )`),
			env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauthClientResource (
        id TEXT PRIMARY KEY, clientId TEXT NOT NULL, resourceId TEXT NOT NULL, metadata TEXT, createdAt TEXT
      )`),
			env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauthConsent (
        id TEXT PRIMARY KEY, clientId TEXT NOT NULL, userId TEXT, referenceId TEXT, resources TEXT,
        requestedUserInfoClaims TEXT, scopes TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`),
			env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauthClientAssertion (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL)`),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, owner_id TEXT NOT NULL, user_id TEXT, device_name TEXT NOT NULL, sync_token TEXT NOT NULL UNIQUE, receive_internals INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_seen_at TEXT, kind TEXT NOT NULL DEFAULT 'plugin', capabilities TEXT, conflict_policy TEXT NOT NULL DEFAULT 'rebase', sync_cursor TEXT)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS device_codes (device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL, vault_id TEXT NOT NULL, owner_id TEXT NOT NULL, device_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, created_at TEXT NOT NULL, approved_by TEXT)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last4 TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used_at TEXT)"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS vault_members (vault_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (vault_id, user_id))"),
			env.DB.prepare("CREATE TABLE IF NOT EXISTS vault_invites (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"),
			env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_invites_pending ON vault_invites (vault_id, email) WHERE status = 'pending'"),
		]);
		await env.DB.prepare("ALTER TABLE devices ADD COLUMN user_id TEXT").run().catch(() => {});
		await env.DB.prepare("ALTER TABLE device_codes ADD COLUMN approved_by TEXT").run().catch(() => {});
	});

	it("serves the web app shell (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toContain("<title>Lapis</title>");
	});

	it("serves the web app shell (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toContain("<title>Lapis</title>");
	});

	it("serves SPA auth routes without redirecting away OAuth errors", async () => {
		const request = new IncomingRequest(
			"http://example.com/auth?error=unable_to_create_user"
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toContain("<title>Lapis</title>");
	});

	it("reports Google auth availability from Worker env", async () => {
		const request = new IncomingRequest("http://example.com/api/auth/providers");
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...env,
				GOOGLE_CLIENT_ID: "google-client",
				GOOGLE_CLIENT_SECRET: "google-secret",
			},
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(await response.json()).toEqual({ google: true });
	});

	it("creates, restores, and permanently signs out an email session", async () => {
		const jar = new CookieJar();
		const email = `auth-${crypto.randomUUID()}@example.com`;

		const signUp = await authRequest(
			"/sign-up/email",
			{
				method: "POST",
				body: JSON.stringify({ name: "Auth Test", email, password: "correct-horse-battery" }),
			},
			jar
		);
		expect(signUp.status).toBe(200);
		expect(await signUp.json()).toMatchObject({ user: { email } });

		const signedInSession = await authRequest("/get-session", {}, jar);
		expect(await signedInSession.json()).toMatchObject({ user: { email } });

		const signOut = await authRequest("/sign-out", { method: "POST" }, jar);
		expect(signOut.status).toBe(200);
		expect(await signOut.json()).toEqual({ success: true });

		const signedOutSession = await authRequest("/get-session", {}, jar);
		expect(await signedOutSession.json()).toBeNull();
	});

	it("rejects email/password registration for an existing Google email", async () => {
		const id = crypto.randomUUID();
		const email = `google-${id}@example.com`;
		const now = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare(
				'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)'
			).bind(id, "Google User", email, now, now),
			env.DB.prepare(
				'INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
			).bind(crypto.randomUUID(), `google-${id}`, "google", id, now, now),
		]);

		const response = await authRequest("/sign-up/email", {
			method: "POST",
			body: JSON.stringify({ name: "Duplicate", email, password: "correct-horse-battery" }),
		});
		expect(response.status).toBe(422);

		const credential = await env.DB.prepare(
			'SELECT id FROM "account" WHERE userId = ? AND providerId = ?'
		)
			.bind(id, "credential")
			.first();
		expect(credential).toBeNull();
	});

	it("does not allow credentialed CORS from an untrusted origin", async () => {
		const request = new IncomingRequest("http://example.com/api/auth/providers", {
			headers: { Origin: "https://attacker.example" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, authEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("renames, archives, lists, and restores vaults", async () => {
		const jar = await signUpJar("vault-life");
		const create = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Original" }) },
			jar
		);
		expect(create.status).toBe(201);
		const vault = await create.json<{ id: string; name: string }>();

		const rename = await apiRequest(
			`/api/vaults/${vault.id}`,
			{ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) },
			jar
		);
		expect(rename.status).toBe(200);
		expect(await rename.json()).toMatchObject({ id: vault.id, name: "Renamed" });

		const archive = await apiRequest(`/api/vaults/${vault.id}/archive`, { method: "POST" }, jar);
		expect(archive.status).toBe(200);

		const active = await apiRequest("/api/vaults", {}, jar);
		expect(await active.json()).toEqual([]);

		const archived = await apiRequest("/api/vaults/archived", {}, jar);
		expect(await archived.json()).toMatchObject([{ id: vault.id, name: "Renamed" }]);

		const blocked = await apiRequest(`/api/vaults/${vault.id}/manifest`, {}, jar);
		expect(blocked.status).toBe(423);
		expect(await blocked.json()).toMatchObject({ error: "Vault is archived" });

		const restore = await apiRequest(`/api/vaults/${vault.id}/restore`, { method: "POST" }, jar);
		expect(restore.status).toBe(200);
		expect(await restore.json()).toMatchObject({ id: vault.id, name: "Renamed", archivedAt: null });
	});

	it("creates and updates default MCP policy for active vaults", async () => {
		const jar = await signUpJar("mcp-policy");
		const create = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "MCP Vault" }) },
			jar
		);
		const vault = await create.json<{ id: string }>();

		const defaults = await apiRequest(`/api/vaults/${vault.id}/mcp-policy`, {}, jar);
		expect(defaults.status).toBe(200);
		expect(await defaults.json()).toMatchObject({
			vaultId: vault.id,
			enabled: false,
			mode: "read-only",
			allowGrep: true,
			allowDelete: false,
		});

		const updated = await apiRequest(
			`/api/vaults/${vault.id}/mcp-policy`,
			{
				method: "PATCH",
				body: JSON.stringify({ enabled: true, mode: "read-write", allowDelete: true }),
			},
			jar
		);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			enabled: true,
			mode: "read-write",
			allowDelete: true,
		});
	});

	it("creates hashed MCP tokens and authenticates /api/mcp without OAuth", async () => {
		const jar = await signUpJar("mcp-token");
		const createdVault = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Token Vault" }) },
			jar
		);
		const vault = await createdVault.json<{ id: string }>();
		await apiRequest(
			`/api/vaults/${vault.id}/mcp-policy`,
			{ method: "PATCH", body: JSON.stringify({ enabled: true }) },
			jar
		);

		const created = await apiRequest(
			"/api/mcp/tokens",
			{ method: "POST", body: JSON.stringify({ name: "ssh box" }) },
			jar
		);
		expect(created.status).toBe(201);
		const issued = await created.json<{
			id: string;
			name: string;
			token: string;
			last4: string;
		}>();
		expect(issued.name).toBe("ssh box");
		expect(issued.token.startsWith("lapis_")).toBe(true);
		expect(issued.last4).toBe(issued.token.slice(-4));

		const listed = await apiRequest("/api/mcp/tokens", {}, jar);
		expect(listed.status).toBe(200);
		const tokens = await listed.json<Array<{ id: string; token?: string }>>();
		expect(tokens).toEqual([expect.objectContaining({ id: issued.id, name: "ssh box" })]);
		expect(tokens[0]?.token).toBeUndefined();

		const listedVaults = await apiRequest("/api/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${issued.token}`,
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_vaults", arguments: {} },
			}),
		});
		expect(listedVaults.status).toBe(200);
		expect(await listedVaults.text()).toContain("Token Vault");

		const invalid = await apiRequest("/api/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer lapis_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		});
		expect(invalid.status).toBe(401);
		expect(invalid.headers.get("WWW-Authenticate")).toBeNull();

		const revoke = await apiRequest(`/api/mcp/tokens/${issued.id}`, { method: "DELETE" }, jar);
		expect(revoke.status).toBe(200);

		const revoked = await apiRequest("/api/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${issued.token}`,
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
		});
		expect(revoked.status).toBe(401);
	});

	it("challenges unauthenticated MCP requests with OAuth metadata", async () => {
		const response = await apiRequest("/api/mcp", {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
	});

	it("folds line patches for pending DO changes", () => {
		const base = "alpha\nbeta\ngamma";
		const first = "alpha\nbeta changed\ngamma";
		const second = "alpha\nbeta changed\ngamma\ndelta";
		const firstPatch = createPatch("note.md", base, first, 1);
		const secondPatch = [
			"--- a/note.md",
			"+++ b/note.md",
			"@@ -1,3 +1,4 @@",
			" alpha",
			" beta changed",
			" gamma",
			"+delta",
			"",
		].join("\n");

		const afterFirst = applyPatch(base, firstPatch);
		expect(afterFirst).toBe(first);
		expect(afterFirst ? applyPatch(afterFirst, secondPatch) : null).toBe(second);
	});

	it("rejects stale patch context", () => {
		const patch = createPatch("note.md", "alpha\nbeta", "alpha\nchanged", 1);
		expect(applyPatch("alpha\nother", patch)).toBeNull();
	});

	it("deviceAuthor produces canonical identity strings", () => {
		expect(deviceAuthor("plugin", "abc-123")).toBe("plugin:abc-123");
		expect(deviceAuthor("web", "sess-1")).toBe("web:sess-1");
		expect(deviceAuthor("agent", "agent-1")).toBe("agent:agent-1");
		expect(deviceAuthor("github", "vault-1")).toBe("github:vault-1");
	});

	it("merge3 produces merged output for identical server head", () => {
		const text = "line1\nline2\nline3";
		const { merged, hasConflicts } = merge3(text, text, text);
		expect(hasConflicts).toBe(false);
		expect(merged).toBe(text);
	});

	it("merge3 flags overlapping edits as conflicts", () => {
		const base = "shared\nline";
		const ours = "ours\nline";
		const theirs = "theirs\nline";
		const { hasConflicts } = merge3(base, ours, theirs);
		expect(hasConflicts).toBe(true);
	});

	it("allows only opted-in hidden paths through device sync", () => {
		expect(isValidSyncPath("notes/visible.md", false)).toBe(true);
		expect(isValidSyncPath(".obsidian/app.json", false)).toBe(false);
		expect(isValidSyncPath(".obsidian/app.json", true)).toBe(true);
		expect(isValidSyncPath(".trash/deleted.md", true)).toBe(true);
		expect(isValidSyncPath("_manifest.json", true)).toBe(false);
		expect(isValidSyncPath(".obsidian/../secret", true)).toBe(false);
	});

	it("classifies managed text by path even with a generic upload MIME", () => {
		expect(contentTypeForUpload("data.json", "application/octet-stream")).toBe(
			"application/json"
		);
		expect(contentTypeForUpload("board.canvas", "application/octet-stream")).toBe(
			"application/json"
		);
		expect(contentTypeForUpload(".obsidian/app.json", "image/png")).toBe(
			"application/json"
		);
		expect(contentTypeForUpload("image.png", "application/octet-stream")).toBe(
			"image/png"
		);
	});

	it("renders conflict notes with frontmatter", () => {
		const path = conflictNotePath({
			path: "notes/foo.md",
			serverRevision: 3,
			clientBaseRevision: 1,
			deviceName: "plugin:dev-1",
			timestamp: "2024-06-01T12:00:00Z",
		});
		expect(path).toContain(".sync-conflicts/");
		const body = renderConflictNote({
			path: "notes/foo.md",
			serverContent: "server",
			clientContent: "client",
			baseContent: "base",
			serverRevision: 3,
			clientBaseRevision: 1,
			deviceName: "plugin:dev-1",
			timestamp: "2024-06-01T12:00:00Z",
		});
		expect(body).toContain("type: sync-conflict");
		expect(body).toContain("server");
		expect(body).toContain("client");
		expect(parseConflictNoteMetadata(body)).toEqual({
			path: "notes/foo.md",
			serverRevision: 3,
			clientBaseRevision: 1,
			isBinary: false,
		});
	});

	it("rejects rename and archive from a different account", async () => {
		const owner = await signUpJar("owner-iso");
		const other = await signUpJar("other-iso");
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Private" }) },
			owner
		);
		const vault = await created.json<{ id: string }>();

		const rename = await apiRequest(
			`/api/vaults/${vault.id}`,
			{ method: "PATCH", body: JSON.stringify({ name: "Hijacked" }) },
			other
		);
		expect(rename.status).toBe(404);

		const archive = await apiRequest(`/api/vaults/${vault.id}/archive`, { method: "POST" }, other);
		expect(archive.status).toBe(404);

		const policy = await apiRequest(`/api/vaults/${vault.id}/mcp-policy`, {}, other);
		expect(policy.status).toBe(404);
	});

	it("lets owners invite editors and viewers who can accept from the inbox", async () => {
		const owner = await signUpAccount("share-owner");
		const editor = await signUpAccount("share-editor");
		const viewer = await signUpAccount("share-viewer");
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Shared" }) },
			owner.jar
		);
		expect(created.status).toBe(201);
		const vault = await created.json<{ id: string; role: string }>();
		expect(vault.role).toBe("owner");

		const inviteEditor = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: editor.email, role: "editor" }) },
			owner.jar
		);
		expect(inviteEditor.status).toBe(201);
		const editorInvite = await inviteEditor.json<{ id: string }>();

		const inviteViewer = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: viewer.email, role: "viewer" }) },
			owner.jar
		);
		expect(inviteViewer.status).toBe(201);
		const viewerInvite = await inviteViewer.json<{ id: string }>();

		const inbox = await apiRequest("/api/invites", {}, editor.jar);
		expect(inbox.status).toBe(200);
		expect(await inbox.json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: editorInvite.id, vaultId: vault.id })])
		);

		expect(
			(await apiRequest(`/api/invites/${editorInvite.id}/accept`, { method: "POST" }, editor.jar)).status
		).toBe(200);
		expect(
			(await apiRequest(`/api/invites/${viewerInvite.id}/accept`, { method: "POST" }, viewer.jar)).status
		).toBe(200);

		const listed = await apiRequest("/api/vaults", {}, editor.jar);
		expect(await listed.json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: vault.id, role: "editor" })])
		);

		const write = await apiRequest(
			`/api/vaults/${vault.id}/files/notes/shared.md`,
			{ method: "PUT", body: JSON.stringify({ content: "hello from editor" }) },
			editor.jar
		);
		expect(write.status).toBe(200);

		const viewerWrite = await apiRequest(
			`/api/vaults/${vault.id}/files/notes/shared.md`,
			{ method: "PUT", body: JSON.stringify({ content: "viewer should fail" }) },
			viewer.jar
		);
		expect(viewerWrite.status).toBe(403);

		const viewerRead = await apiRequest(`/api/vaults/${vault.id}/files/notes/shared.md`, {}, viewer.jar);
		expect(viewerRead.status).toBe(200);

		const editorRename = await apiRequest(
			`/api/vaults/${vault.id}`,
			{ method: "PATCH", body: JSON.stringify({ name: "Hijack" }) },
			editor.jar
		);
		expect(editorRename.status).toBe(403);

		const editorPolicy = await apiRequest(`/api/vaults/${vault.id}/mcp-policy`, {}, editor.jar);
		expect(editorPolicy.status).toBe(403);

		const viewerInviteAttempt = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: "nobody@example.com", role: "viewer" }) },
			viewer.jar
		);
		expect(viewerInviteAttempt.status).toBe(403);

		const editorInviteAttempt = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: "another@example.com", role: "viewer" }) },
			editor.jar
		);
		expect(editorInviteAttempt.status).toBe(201);
	});

	it("exposes shared vaults to member MCP tokens and keeps viewers read-only", async () => {
		const owner = await signUpAccount("mcp-share-owner");
		const editor = await signUpAccount("mcp-share-editor");
		const viewer = await signUpAccount("mcp-share-viewer");
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "MCP Shared" }) },
			owner.jar
		);
		const vault = await created.json<{ id: string }>();
		await apiRequest(
			`/api/vaults/${vault.id}/mcp-policy`,
			{
				method: "PATCH",
				body: JSON.stringify({ enabled: true, mode: "read-write", allowDelete: true }),
			},
			owner.jar
		);
		await apiRequest(
			`/api/vaults/${vault.id}/files/notes/alpha.md`,
			{ method: "PUT", body: JSON.stringify({ content: "shared note\n" }) },
			owner.jar
		);

		const inviteEditor = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: editor.email, role: "editor" }) },
			owner.jar
		);
		const editorInvite = await inviteEditor.json<{ id: string }>();
		await apiRequest(`/api/invites/${editorInvite.id}/accept`, { method: "POST" }, editor.jar);

		const inviteViewer = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: viewer.email, role: "viewer" }) },
			owner.jar
		);
		const viewerInvite = await inviteViewer.json<{ id: string }>();
		await apiRequest(`/api/invites/${viewerInvite.id}/accept`, { method: "POST" }, viewer.jar);

		async function callTool(userId: string, name: string, args: Record<string, unknown>) {
			const handler = createLapisMcpHandler(authEnv, { sub: userId, client_id: "share-test" });
			const request = new IncomingRequest("http://example.com/api/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const response = await handler.fetch(request);
			const text = await response.text();
			const dataLine = text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.at(-1);
			const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as {
				result?: { content?: Array<{ text?: string }>; isError?: boolean };
				error?: { message?: string };
			};
			const raw = payload.result?.content?.[0]?.text ?? payload.error?.message ?? text;
			let parsed: unknown = raw;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// keep string
			}
			return { isError: Boolean(payload.result?.isError || payload.error), parsed, raw };
		}

		const listed = await callTool(editor.userId, "list_vaults", {});
		expect(listed.parsed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: vault.id, role: "editor", mode: "read-write" }),
			])
		);

		const viewerListed = await callTool(viewer.userId, "list_vaults", {});
		expect(viewerListed.parsed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: vault.id, role: "viewer", mode: "read-only" }),
			])
		);

		const viewerWrite = await callTool(viewer.userId, "write", {
			vault: vault.id,
			path: "notes/from-viewer.md",
			content: "nope",
		});
		expect(viewerWrite.isError || String(viewerWrite.raw).includes("read/write")).toBe(true);

		const editorWrite = await callTool(editor.userId, "write", {
			vault: vault.id,
			path: "notes/from-editor.md",
			content: "ok",
		});
		expect(editorWrite.isError).toBe(false);
	});

	it("gates plugin sync writes by the paired member's role", async () => {
		const owner = await signUpAccount("plugin-share-owner");
		const editor = await signUpAccount("plugin-share-editor");
		const viewer = await signUpAccount("plugin-share-viewer");
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Plugin Shared" }) },
			owner.jar
		);
		const vault = await created.json<{ id: string }>();

		const inviteEditor = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: editor.email, role: "editor" }) },
			owner.jar
		);
		const editorInvite = await inviteEditor.json<{ id: string }>();
		await apiRequest(`/api/invites/${editorInvite.id}/accept`, { method: "POST" }, editor.jar);

		const inviteViewer = await apiRequest(
			`/api/vaults/${vault.id}/invites`,
			{ method: "POST", body: JSON.stringify({ email: viewer.email, role: "viewer" }) },
			owner.jar
		);
		const viewerInvite = await inviteViewer.json<{ id: string }>();
		await apiRequest(`/api/invites/${viewerInvite.id}/accept`, { method: "POST" }, viewer.jar);

		async function pair(jar: CookieJar, deviceName: string) {
			const requested = await apiRequest(
				"/api/device-auth/request",
				{ method: "POST", body: JSON.stringify({ vaultId: vault.id, deviceName }) }
			);
			expect(requested.status).toBe(200);
			const challenge = await requested.json<{ deviceCode: string; userCode: string }>();
			const approved = await apiRequest(
				`/api/vaults/${vault.id}/devices/approve`,
				{ method: "POST", body: JSON.stringify({ userCode: challenge.userCode }) },
				jar
			);
			expect(approved.status).toBe(200);
			const polled = await apiRequest(
				"/api/device-auth/token",
				{ method: "POST", body: JSON.stringify({ deviceCode: challenge.deviceCode }) }
			);
			expect(polled.status).toBe(200);
			return polled.json<{ token: string; deviceId: string; writable: boolean; role: string }>();
		}

		const editorDevice = await pair(editor.jar, "Editor Obsidian");
		expect(editorDevice).toMatchObject({ writable: true, role: "editor" });

		const editorPut = await apiRequest(`/api/sync/${vault.id}/files/notes/from-plugin.md`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${editorDevice.token}` },
			body: "from editor plugin",
		});
		expect(editorPut.status).toBe(200);

		const viewerDevice = await pair(viewer.jar, "Viewer Obsidian");
		expect(viewerDevice).toMatchObject({ writable: false, role: "viewer" });

		const viewerInfo = await apiRequest(`/api/sync/${vault.id}/device`, {
			headers: { Authorization: `Bearer ${viewerDevice.token}` },
		});
		expect(viewerInfo.status).toBe(200);
		expect(await viewerInfo.json()).toMatchObject({ writable: false, role: "viewer" });

		const viewerManifest = await apiRequest(`/api/sync/${vault.id}/manifest`, {
			headers: { Authorization: `Bearer ${viewerDevice.token}` },
		});
		expect(viewerManifest.status).toBe(200);

		const viewerPut = await apiRequest(`/api/sync/${vault.id}/files/notes/from-viewer-plugin.md`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${viewerDevice.token}` },
			body: "should fail",
		});
		expect(viewerPut.status).toBe(403);

		const legacyToken = `legacy-${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO devices (id, vault_id, owner_id, device_name, sync_token, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, 'plugin')`
		)
			.bind(crypto.randomUUID(), vault.id, owner.userId, "Legacy Obsidian", legacyToken, new Date().toISOString())
			.run();
		const legacyPut = await apiRequest(`/api/sync/${vault.id}/files/notes/from-legacy.md`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${legacyToken}` },
			body: "legacy owner still writes",
		});
		expect(legacyPut.status).toBe(200);
	});

	it("rejects plugin sync against an archived vault", async () => {
		const jar = await signUpJar("sync-arch");
		const session = await (await authRequest("/get-session", {}, jar)).json<{ user: { id: string } }>();
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Sync Archive" }) },
			jar
		);
		const vault = await created.json<{ id: string }>();
		const token = `sync-${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO devices (id, vault_id, owner_id, device_name, sync_token, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, 'plugin')`
		)
			.bind(crypto.randomUUID(), vault.id, session.user.id, "Obsidian", token, new Date().toISOString())
			.run();

		await apiRequest(`/api/vaults/${vault.id}/archive`, { method: "POST" }, jar);
		const sync = await apiRequest(`/api/sync/${vault.id}/manifest`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(sync.status).toBe(423);
		expect(await sync.json()).toMatchObject({ error: "Vault is archived" });
	});

	it("serves OAuth discovery for the MCP resource", async () => {
		const challenge = await apiRequest("/api/mcp", {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		const www = challenge.headers.get("WWW-Authenticate") ?? "";
		expect(www).toContain("resource_metadata");
		const metadataUrl = www.match(/resource_metadata="([^"]+)"/)?.[1];
		expect(metadataUrl).toBeTruthy();

		const metadata = await apiRequest(new URL(metadataUrl!).pathname);
		expect(metadata.status).toBe(200);
		const body = await metadata.json<{ resource?: string; authorization_servers?: string[] }>();
		expect(body.resource ?? "").toContain("/api/mcp");
		expect(body.authorization_servers?.length).toBeGreaterThan(0);
	});

	it("exposes coding-agent MCP tools with policy, grep, and revision checks", async () => {
		const jar = await signUpJar("mcp-tools");
		const session = await (await authRequest("/get-session", {}, jar)).json<{ user: { id: string } }>();
		const created = await apiRequest(
			"/api/vaults",
			{ method: "POST", body: JSON.stringify({ name: "Agent Vault" }) },
			jar
		);
		const vault = await created.json<{ id: string }>();
		await apiRequest(
			`/api/vaults/${vault.id}/mcp-policy`,
			{
				method: "PATCH",
				body: JSON.stringify({
					enabled: true,
					mode: "read-write",
					allowGrep: true,
					allowDelete: false,
					pathDeny: ["secret.md"],
				}),
			},
			jar
		);
		const note = await apiRequest(
			`/api/vaults/${vault.id}/files/notes/alpha.md`,
			{ method: "PUT", body: JSON.stringify({ content: "alpha\nTODO find me\nalpha again\n" }) },
			jar
		);
		expect(note.status).toBe(200);
		const written = await note.json<{ revision: number }>();
		await apiRequest(
			`/api/vaults/${vault.id}/files/secret.md`,
			{ method: "PUT", body: JSON.stringify({ content: "hidden secret" }) },
			jar
		);

		const handler = createLapisMcpHandler(authEnv, {
			sub: session.user.id,
			client_id: "cursor-test",
		});

		async function callTool(name: string, args: Record<string, unknown>) {
			const request = new IncomingRequest("http://example.com/api/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const response = await handler.fetch(request);
			const text = await response.text();
			const dataLine = text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.at(-1);
			const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as {
				result?: { content?: Array<{ text?: string }>; isError?: boolean };
				error?: { message?: string };
			};
			const raw = payload.result?.content?.[0]?.text ?? payload.error?.message ?? text;
			let parsed: unknown = raw;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// keep string
			}
			return { status: response.status, isError: Boolean(payload.result?.isError || payload.error), parsed, raw };
		}

		const listed = await callTool("list_vaults", {});
		expect(listed.parsed).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: vault.id, name: "Agent Vault" })])
		);

		const read = await callTool("read", { vault: vault.id, path: "notes/alpha.md", offset: 2, limit: 1 });
		expect(read.parsed).toMatchObject({
			path: "notes/alpha.md",
			startLine: 2,
			text: "2|TODO find me",
			truncated: true,
		});

		const denied = await callTool("read", { vault: vault.id, path: "secret.md" });
		expect(denied.isError || String(denied.raw).includes("denied")).toBe(true);

		const grep = await callTool("grep", {
			vault: vault.id,
			pattern: "TODO",
			glob: "notes/**",
			context: 1,
		});
		expect(grep.parsed).toMatchObject({
			totalMatches: 1,
			matches: [expect.objectContaining({ path: "notes/alpha.md", line: 2 })],
		});

		const ambiguous = await callTool("edit", {
			vault: vault.id,
			path: "notes/alpha.md",
			old_string: "alpha",
			new_string: "beta",
			baseRevision: written.revision,
		});
		expect(ambiguous.isError || String(ambiguous.raw).includes("not unique")).toBe(true);

		const overwrite = await callTool("write", {
			vault: vault.id,
			path: "notes/alpha.md",
			content: "replaced",
		});
		expect(overwrite.isError || String(overwrite.raw).includes("baseRevision")).toBe(true);

		const rm = await callTool("rm", { vault: vault.id, path: "notes/alpha.md" });
		expect(rm.isError || String(rm.raw).includes("disabled")).toBe(true);

		const other = await signUpJar("mcp-other");
		const otherSession = await (await authRequest("/get-session", {}, other)).json<{ user: { id: string } }>();
		const isolated = createLapisMcpHandler(authEnv, {
			sub: otherSession.user.id,
			client_id: "other-client",
		});
		const isolatedReq = new IncomingRequest("http://example.com/api/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "read", arguments: { vault: vault.id, path: "notes/alpha.md" } },
			}),
		});
		const isolatedRes = await isolated.fetch(isolatedReq);
		const isolatedText = await isolatedRes.text();
		expect(isolatedText).toMatch(/not enabled|No active vaults/i);
	});

	it("encrypts PATs without exposing plaintext in ciphertext", async () => {
		const kek = "test-key-32-bytes-long-enough!!";
		const pat = "ghp_supersecrettokenvalue123456";
		const ciphertext = await encryptPat(kek, pat);
		expect(ciphertext).not.toContain(pat);
		expect(patLast4(pat)).toBe("3456");
		const roundTrip = await decryptPat(kek, ciphertext);
		expect(roundTrip).toBe(pat);
	});
});
