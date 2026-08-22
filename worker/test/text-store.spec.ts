import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { contentKey } from "../src/vault/manifest";
import { VaultCoordinator } from "../src/vault/coordinator";
import { createPatch } from "../src/vault/patch";
import {
  SQLITE_TEXT_STORAGE_VERSION,
  isTextContentType,
} from "../src/vault/contracts";
import { TEXT_CHUNK_SIZE, chunkUtf8 } from "../src/vault/text-store";

function coordinator(vaultId: string) {
  return env.VAULT_COORDINATOR.get(
    env.VAULT_COORDINATOR.idFromName(vaultId)
  );
}

async function initialize(vaultId: string) {
  const stub = coordinator(vaultId);
  await stub.initialize({
    id: vaultId,
    ownerId: "owner-1",
    name: "Test vault",
    createdAt: new Date().toISOString(),
  });
  return stub;
}

describe("SQLite text heads", () => {
  it("classifies every supported text MIME contract", () => {
    expect(isTextContentType("text/markdown")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("application/xml")).toBe(true);
    expect(isTextContentType("image/svg+xml")).toBe(true);
    expect(isTextContentType("image/png")).toBe(false);
  });

  it("splits chunks only at valid UTF-8 boundaries", () => {
    const chunks = chunkUtf8("1234567😀abcdef", 8);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decoded = chunks.map((chunk) => decoder.decode(chunk.data));

    expect(decoded.join("")).toBe("1234567😀abcdef");
    expect(chunks.every((chunk) => chunk.data.byteLength <= 8)).toBe(true);
  });

  it("persists a multi-chunk head without an R2 text object", async () => {
    const vaultId = crypto.randomUUID();
    const path = "notes/large.md";
    const text = `${"a".repeat(TEXT_CHUNK_SIZE - 1)}😀${"z".repeat(TEXT_CHUNK_SIZE)}`;
    const bytes = new TextEncoder().encode(text);
    const stub = await initialize(vaultId);

    expect(await stub.getStorageVersion()).toBe(SQLITE_TEXT_STORAGE_VERSION);
    const entry = await stub.syncPutFile(
      vaultId,
      path,
      bytes.buffer as ArrayBuffer,
      "text/markdown",
      undefined,
      "test"
    );
    expect(entry.size).toBe(bytes.byteLength);

    await runInDurableObject(
      stub,
      async (instance: VaultCoordinator, state) => {
        const rows = state.storage.sql
          .exec<{ chunkIndex: number; data: ArrayBuffer }>(
            `SELECT chunk_idx AS chunkIndex, data
             FROM text_chunks WHERE path_lower = ? ORDER BY chunk_idx`,
            path.toLowerCase()
          )
          .toArray();
        expect(rows.length).toBeGreaterThan(1);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (let index = 0; index < rows.length; index++) {
          expect(rows[index].chunkIndex).toBe(index);
          expect(() => decoder.decode(rows[index].data)).not.toThrow();
        }

        // Simulate eviction of the process-local cache. The next RPC must
        // reconstruct the head solely from persisted SQLite chunks.
        (
          instance as unknown as {
            headContent: Map<string, string>;
          }
        ).headContent.clear();
      }
    );

    const content = await stub.getContent(vaultId, path);
    expect(content).not.toBeNull();
    expect(new TextDecoder().decode(content?.bytes)).toBe(text);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();

    await stub.flushToR2(vaultId);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();
  });

  it("renames and deletes SQLite text while binaries remain in R2", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const textPath = "old.md";
    const renamedPath = "folder/new.md";
    const text = "hello";
    const binaryPath = "image.png";
    const binary = new Uint8Array([1, 2, 3, 4]);

    await stub.syncPutFile(
      vaultId,
      textPath,
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      "text/markdown"
    );
    await stub.syncPutFile(
      vaultId,
      binaryPath,
      binary.buffer as ArrayBuffer,
      "image/png"
    );

    await stub.syncRenameFile(vaultId, textPath, renamedPath);
    expect(await stub.getContent(vaultId, textPath)).toBeNull();
    const renamed = await stub.getContent(vaultId, renamedPath);
    expect(new TextDecoder().decode(renamed?.bytes)).toBe(text);
    expect(
      await env.VAULT_BUCKET.get(contentKey(vaultId, renamedPath))
    ).toBeNull();

    const binaryObject = await env.VAULT_BUCKET.get(
      contentKey(vaultId, binaryPath)
    );
    expect(Array.from(new Uint8Array(await binaryObject!.arrayBuffer()))).toEqual(
      Array.from(binary)
    );

    await stub.syncDeleteFile(vaultId, renamedPath);
    expect(await stub.getContent(vaultId, renamedPath)).toBeNull();
    await runInDurableObject(stub, async (_instance, state) => {
      const metadata = state.storage.sql
        .exec(
          `SELECT path_lower FROM text_files WHERE path_lower = ?`,
          renamedPath.toLowerCase()
        )
        .toArray();
      const chunks = state.storage.sql
        .exec(
          `SELECT chunk_idx FROM text_chunks WHERE path_lower = ?`,
          renamedPath.toLowerCase()
        )
        .toArray();
      expect(metadata).toHaveLength(0);
      expect(chunks).toHaveLength(0);
    });
  });

  it("applies patches from the persisted SQLite head after flush", async () => {
    const vaultId = crypto.randomUUID();
    const path = "patched.md";
    const original = "\uFEFFalpha\nbeta";
    const modified = "\uFEFFalpha\nbeta changed";
    const stub = await initialize(vaultId);
    const first = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(original).buffer as ArrayBuffer,
      "text/markdown"
    );

    await stub.flushToR2(vaultId);
    const patch = createPatch(
      path,
      original,
      modified,
      first.revision
    );
    const second = await stub.syncApplyPatch(
      vaultId,
      path,
      patch,
      first.revision
    );

    expect(second.revision).toBe(first.revision + 1);
    const content = await stub.getContent(vaultId, path);
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(content?.bytes)
    ).toBe(modified);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();
  });
});
