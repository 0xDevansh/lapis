import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { applyPatch, createPatch } from "../src/vault/patch";

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
});
