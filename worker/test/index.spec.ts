import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
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

describe("Lapis worker", () => {
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
