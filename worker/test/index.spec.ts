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

describe("Lapis worker", () => {
	beforeAll(async () => {
		await env.DB.batch([
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES "user"(id))'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES "user"(id), accessToken TEXT, refreshToken TEXT, idToken TEXT, expiresAt TEXT, accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)'),
			env.DB.prepare('CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)'),
		]);
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
