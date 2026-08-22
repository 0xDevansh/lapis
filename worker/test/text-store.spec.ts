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
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    });
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
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        });
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
      new TextDecoder("utf-8", {
        fatal: false,
        ignoreBOM: true,
      }).decode(content?.bytes)
    ).toBe(modified);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();
  });

  it("serves a mixed first seed through every coordinator read helper", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const files = [
      { path: "notes/one.md", contentType: "text/markdown", text: "# One" },
      { path: "data.json", contentType: "application/json", text: "{\"ok\":true}" },
      { path: "diagram.svg", contentType: "image/svg+xml", text: "<svg></svg>" },
    ];
    const binaryPath = "attachments/pixel.png";
    const binary = new Uint8Array([137, 80, 78, 71]);

    for (const file of files) {
      await stub.syncPutFile(
        vaultId,
        file.path,
        new TextEncoder().encode(file.text).buffer as ArrayBuffer,
        file.contentType
      );
    }
    await stub.syncPutFile(
      vaultId,
      binaryPath,
      binary.buffer as ArrayBuffer,
      "image/png"
    );
    await stub.flushToR2(vaultId);

    await runInDurableObject(stub, async (instance: VaultCoordinator) => {
      (
        instance as unknown as {
          headContent: Map<string, string>;
        }
      ).headContent.clear();
    });

    const manifest = await stub.getManifest(vaultId);
    expect(Object.keys(manifest.entries)).toHaveLength(files.length + 1);

    const listed = await stub.listContent(vaultId);
    const listedByPath = new Map(
      listed.map((entry) => [entry.path, entry.data])
    );
    for (const file of files) {
      expect(new TextDecoder().decode(listedByPath.get(file.path))).toBe(
        file.text
      );
      expect(
        await env.VAULT_BUCKET.get(contentKey(vaultId, file.path))
      ).toBeNull();
    }
    expect(Array.from(listedByPath.get(binaryPath) ?? [])).toEqual(
      Array.from(binary)
    );
    const storedBinary = await env.VAULT_BUCKET.get(
      contentKey(vaultId, binaryPath)
    );
    expect(storedBinary).not.toBeNull();
    expect(
      Array.from(new Uint8Array(await storedBinary!.arrayBuffer()))
    ).toEqual(Array.from(binary));
  });

  it("migrates legacy R2 text into SQLite and deletes only verified text keys", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const textPath = "legacy/note.md";
    const binaryPath = "legacy/image.png";
    const text = "legacy text\nwith unicode 😀";
    const textBytes = new TextEncoder().encode(text);
    const binary = new Uint8Array([9, 8, 7]);
    const updatedAt = new Date().toISOString();

    await runInDurableObject(stub, async (instance: VaultCoordinator, state) => {
      const bucket = (
        instance as unknown as { env: { VAULT_BUCKET: R2Bucket } }
      ).env.VAULT_BUCKET;
      await bucket.put(contentKey(vaultId, textPath), textBytes.buffer as ArrayBuffer, {
        httpMetadata: { contentType: "text/markdown" },
      });
      await bucket.put(contentKey(vaultId, binaryPath), binary.buffer as ArrayBuffer, {
        httpMetadata: { contentType: "image/png" },
      });
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO do_state (key, value) VALUES ('storage_version', '1')`
      );
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO manifest_entries
         (path_lower, path, size, content_type, updated_at, revision, r2_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        textPath.toLowerCase(),
        textPath,
        textBytes.byteLength,
        "text/markdown",
        updatedAt,
        3,
        3
      );
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO manifest_entries
         (path_lower, path, size, content_type, updated_at, revision, r2_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        binaryPath.toLowerCase(),
        binaryPath,
        binary.byteLength,
        "image/png",
        updatedAt,
        1,
        1
      );
    });

    const content = await stub.getContent(vaultId, textPath);
    expect(new TextDecoder().decode(content?.bytes)).toBe(text);
    expect(await stub.getStorageVersion()).toBe(SQLITE_TEXT_STORAGE_VERSION);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, textPath))).toBeNull();
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, binaryPath))).not.toBeNull();

    await runInDurableObject(stub, async (_instance, state) => {
      const head = state.storage.sql
        .exec(`SELECT revision, size FROM text_files WHERE path_lower = ?`, textPath.toLowerCase())
        .toArray()[0];
      const checkpoint = state.storage.sql
        .exec(`SELECT revision, size FROM text_checkpoints WHERE path_lower = ?`, textPath.toLowerCase())
        .toArray()[0];
      const r2Revision = state.storage.sql
        .exec<{ r2Revision: number }>(
          `SELECT r2_revision AS r2Revision FROM manifest_entries WHERE path_lower = ?`,
          textPath.toLowerCase()
        )
        .toArray()[0]?.r2Revision;

      expect(head).toMatchObject({ revision: 3, size: textBytes.byteLength });
      expect(checkpoint).toMatchObject({ revision: 3, size: textBytes.byteLength });
      expect(r2Revision).toBe(0);
    });
  });

  it("folds legacy pending text patches before migrating from R2", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "legacy/pending.md";
    const original = "alpha\nbeta\n";
    const modified = "alpha\nbeta changed\n";
    const originalBytes = new TextEncoder().encode(original);
    const modifiedBytes = new TextEncoder().encode(modified);
    const patch = createPatch(path, original, modified, 1);
    const updatedAt = new Date().toISOString();

    await runInDurableObject(stub, async (instance: VaultCoordinator, state) => {
      const bucket = (
        instance as unknown as { env: { VAULT_BUCKET: R2Bucket } }
      ).env.VAULT_BUCKET;
      await bucket.put(contentKey(vaultId, path), originalBytes.buffer as ArrayBuffer, {
        httpMetadata: { contentType: "text/markdown" },
      });
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO do_state (key, value) VALUES ('storage_version', '1')`
      );
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO manifest_entries
         (path_lower, path, size, content_type, updated_at, revision, r2_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        path.toLowerCase(),
        path,
        modifiedBytes.byteLength,
        "text/markdown",
        updatedAt,
        2,
        1
      );
      state.storage.sql.exec(
        `INSERT INTO pending_ops
         (path_lower, kind, path, patch, content_type, base_revision, new_revision, author, ts)
         VALUES (?, 'patch', ?, ?, 'text/markdown', 1, 2, 'legacy', ?)`,
        path.toLowerCase(),
        path,
        patch,
        updatedAt
      );
    });

    const content = await stub.getContent(vaultId, path);
    expect(new TextDecoder().decode(content?.bytes)).toBe(modified);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();
  });
});
