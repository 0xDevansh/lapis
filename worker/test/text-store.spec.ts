import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobKey, contentKey, type ManifestEntry } from "../src/vault/manifest";
import { VaultCoordinator } from "../src/vault/coordinator";
import { createPatch } from "../src/vault/patch";
import {
  SQLITE_TEXT_STORAGE_VERSION,
  isTextContentType,
} from "../src/vault/contracts";
import { TEXT_CHUNK_SIZE, chunkUtf8 } from "../src/vault/text-store";
import { formatLfsPointer, parseLfsPointer } from "../src/git/lfs-pointer";

function coordinator(vaultId: string) {
  return env.VAULT_COORDINATOR.get(
    env.VAULT_COORDINATOR.idFromName(vaultId)
  );
}

async function initialize(vaultId: string) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      sync_token TEXT NOT NULL UNIQUE,
      receive_internals INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      kind TEXT NOT NULL DEFAULT 'plugin',
      capabilities TEXT,
      conflict_policy TEXT NOT NULL DEFAULT 'rebase',
      sync_cursor TEXT
    )`
  ).run();
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
  it("formats and parses standard Git LFS pointers", () => {
    const oid = "a".repeat(64);
    const pointer = formatLfsPointer({ oid, size: 12345 });
    expect(pointer).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`
    );
    expect(parseLfsPointer(pointer)).toEqual({ oid, size: 12345 });
    expect(parseLfsPointer("not a pointer")).toBeNull();
  });

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
        const checkpoint = (
          instance as unknown as {
            textStore: {
              readCheckpoint(path: string): { revision: number; text: string } | null;
            };
          }
        ).textStore.readCheckpoint(path);
        expect(checkpoint?.revision).toBe(entry.revision);
        expect(checkpoint?.text).toBe(text);

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

  it("reports bounded storage, history, ack, and R2 text metrics", async () => {
    const vaultId = crypto.randomUUID();
    const path = "metrics.md";
    const stub = await initialize(vaultId);
    const first = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("one").buffer as ArrayBuffer,
      "text/markdown"
    );
    const second = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("two").buffer as ArrayBuffer,
      "text/markdown",
      first.revision
    );

    const beforeAck = await stub.getStorageMetrics();
    expect(beforeAck).toMatchObject({
      storageVersion: SQLITE_TEXT_STORAGE_VERSION,
      r2TextPuts: 0,
      textFileCount: 1,
      textUpdateCount: 1,
      maxChainLength: 1,
      maxAckLagRevisions: 1,
      openConflicts: 0,
      resolvedConflicts: 0,
      conflictResolveRate: 0,
    });
    expect(beforeAck.doStorageBytes).toBeGreaterThan(0);

    await stub.recordAcks(vaultId, "plugin:metrics", {
      acks: [{ path, revision: second.revision }],
    });
    const afterAck = await stub.getStorageMetrics();
    expect(afterAck.textUpdateCount).toBe(0);
    expect(afterAck.maxChainLength).toBe(0);
    expect(afterAck.maxAckLagRevisions).toBe(0);
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
    const binaryEntry = await stub.syncPutFile(
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

    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, binaryPath))).toBeNull();
    expect(binaryEntry.blobOid).toMatch(/^[0-9a-f]{64}$/);
    const binaryObject = await env.VAULT_BUCKET.get(
      blobKey(vaultId, binaryEntry.blobOid!)
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
    const binaryEntry = await stub.syncPutFile(
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
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, binaryPath))).toBeNull();
    expect(binaryEntry.blobOid).toMatch(/^[0-9a-f]{64}$/);
    const storedBinary = await env.VAULT_BUCKET.get(
      blobKey(vaultId, binaryEntry.blobOid!)
    );
    expect(storedBinary).not.toBeNull();
    expect(
      Array.from(new Uint8Array(await storedBinary!.arrayBuffer()))
    ).toEqual(Array.from(binary));
  });

  it("stores opted-in Vault Internals by MIME during first seed", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const textPath = ".obsidian/app.json";
    const binaryPath = ".obsidian/icons/theme.png";
    const text = "{\"legacyEditor\":false}";
    const binary = new Uint8Array([1, 3, 3, 7]);

    await expect(
      stub.syncPutFile(
        vaultId,
        textPath,
        new TextEncoder().encode(text).buffer as ArrayBuffer,
        "application/json"
      )
    ).rejects.toThrow("Invalid path");

    const textEntry = await stub.syncPutFile(
      vaultId,
      textPath,
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      "application/json",
      undefined,
      "plugin:test",
      "rebase",
      true
    );
    const binaryEntry = await stub.syncPutFile(
      vaultId,
      binaryPath,
      binary.buffer as ArrayBuffer,
      "image/png",
      undefined,
      "plugin:test",
      "rebase",
      true
    );

    expect(textEntry.revision).toBe(1);
    expect(binaryEntry.revision).toBe(1);
    expect(
      new TextDecoder().decode(
        (await stub.getContent(vaultId, textPath))?.bytes
      )
    ).toBe(text);
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, textPath))).toBeNull();
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, binaryPath))).toBeNull();
    expect(binaryEntry.blobOid).toMatch(/^[0-9a-f]{64}$/);
    const storedBinary = await env.VAULT_BUCKET.get(
      blobKey(vaultId, binaryEntry.blobOid!)
    );
    expect(
      Array.from(new Uint8Array(await storedBinary!.arrayBuffer()))
    ).toEqual(Array.from(binary));
    expect(await stub.getStorageMetrics()).toMatchObject({
      r2TextPuts: 0,
      textFileCount: 1,
    });

    await stub.syncDeleteFile(vaultId, textPath, "plugin:test", true);
    expect(await stub.getContent(vaultId, textPath)).toBeNull();
  });

  it("commits binaries larger than the DO RPC limit through R2 staging", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "attachments/large.bin";
    const stagingKey = `${vaultId}/_staging/${crypto.randomUUID()}`;
    const bytes = new Uint8Array(33 * 1024 * 1024);
    bytes[0] = 17;
    bytes[bytes.length - 1] = 29;
    await env.VAULT_BUCKET.put(stagingKey, bytes);

    const entry = await stub.syncPutStagedFile(
      vaultId,
      path,
      stagingKey,
      "application/octet-stream"
    );

    expect(entry.size).toBe(bytes.byteLength);
    expect(entry.blobOid).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.VAULT_BUCKET.get(stagingKey)).toBeNull();
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, path))).toBeNull();
    const stored = await env.VAULT_BUCKET.get(blobKey(vaultId, entry.blobOid!));
    expect(stored?.size).toBe(bytes.byteLength);
    const response = await stub.fetch(
      new Request(
        `https://do-internal/content?vaultId=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(
      String(bytes.byteLength)
    );
    const downloaded = new Uint8Array(await response.arrayBuffer());
    expect(downloaded[0]).toBe(17);
    expect(downloaded[downloaded.length - 1]).toBe(29);
  });

  it("deduplicates binary blobs and renames binaries with metadata only", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const bytes = new Uint8Array([4, 5, 6, 7]);

    const first = await stub.syncPutFile(
      vaultId,
      "a.bin",
      bytes.buffer as ArrayBuffer,
      "application/octet-stream"
    );
    const second = await stub.syncPutFile(
      vaultId,
      "folder/b.bin",
      bytes.buffer as ArrayBuffer,
      "application/octet-stream"
    );

    expect(first.blobOid).toBe(second.blobOid);
    expect(await env.VAULT_BUCKET.get(blobKey(vaultId, first.blobOid!))).not.toBeNull();
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, "a.bin"))).toBeNull();
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, "folder/b.bin"))).toBeNull();

    const renamed = await stub.syncRenameFile(vaultId, "a.bin", "renamed.bin");
    expect(renamed.blobOid).toBe(first.blobOid);
    expect(renamed.r2Key).toBe(blobKey(vaultId, first.blobOid!));
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, "renamed.bin"))).toBeNull();

    await stub.syncDeleteFile(vaultId, "folder/b.bin");
    expect(await env.VAULT_BUCKET.get(blobKey(vaultId, first.blobOid!))).not.toBeNull();
    const content = await stub.getContent(vaultId, "renamed.bin");
    expect(Array.from(new Uint8Array(content!.bytes))).toEqual(Array.from(bytes));
  });

  it("treats a missing reconcile cursor as no shared text base", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "first-reconcile.md";
    const server = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("server").buffer as ArrayBuffer,
      "text/markdown"
    );

    const result = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("local").buffer as ArrayBuffer,
      "text/markdown",
      -1,
      "plugin:first-connect"
    );

    expect(result.conflict).toMatchObject({
      path,
      serverRevision: server.revision,
      clientBaseRevision: -1,
      serverContent: "server",
      clientContent: "local",
    });
    expect(
      new TextDecoder().decode((await stub.getContent(vaultId, path))?.bytes)
    ).toBe("server");
  });

  it("keeps the web head when plugin and web replace the same base line", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "same-line-conflict.md";
    const base = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(
        "Keep this line\nChange this exact line\nKeep this too"
      ).buffer as ArrayBuffer,
      "text/markdown"
    );
    const web = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(
        "Keep this line\nWeb version\nKeep this too"
      ).buffer as ArrayBuffer,
      "text/markdown",
      base.revision,
      "web:test"
    );

    const plugin = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(
        "Keep this line\nPlugin version\nKeep this too"
      ).buffer as ArrayBuffer,
      "text/markdown",
      base.revision,
      "plugin:test"
    );

    expect(plugin.conflict).toMatchObject({
      path,
      serverRevision: web.revision,
      clientBaseRevision: base.revision,
      serverContent: "Keep this line\nWeb version\nKeep this too",
      clientContent: "Keep this line\nPlugin version\nKeep this too",
      baseContent: "Keep this line\nChange this exact line\nKeep this too",
    });
    expect(
      new TextDecoder().decode((await stub.getContent(vaultId, path))?.bytes)
    ).toBe("Keep this line\nWeb version\nKeep this too");
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
    expect(await env.VAULT_BUCKET.get(contentKey(vaultId, binaryPath))).toBeNull();
    const migratedManifest = await stub.getManifest(vaultId);
    const migratedBinary = migratedManifest.entries[binaryPath.toLowerCase()];
    expect(migratedBinary.blobOid).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await env.VAULT_BUCKET.get(blobKey(vaultId, migratedBinary.blobOid!))
    ).not.toBeNull();

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

  it("reconstructs SQLite ancestors from checkpointed text updates", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "history.md";
    const revisions = Array.from(
      { length: 51 },
      (_, revision) =>
        `${Array.from({ length: revision + 1 }, (_value, line) => `line ${line}`).join("\n")}\n`
    );
    const entries: ManifestEntry[] = [];

    for (const revision of revisions) {
      entries.push(
        await stub.syncPutFile(
          vaultId,
          path,
          new TextEncoder().encode(revision).buffer as ArrayBuffer,
          "text/markdown",
          entries.at(-1)?.revision
        )
      );
    }

    await runInDurableObject(stub, async (instance: VaultCoordinator) => {
      const store = (
        instance as unknown as {
          textStore: { reconstruct(path: string, revision: number): string | null };
        }
      ).textStore;

      for (const [index, entry] of entries.entries()) {
        expect(store.reconstruct(path, entry.revision)).toBe(revisions[index]);
      }
    });
  });

  it("chunks oversized update patches and reconstructs through them", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "large-update.md";
    const firstText = `${"a".repeat(TEXT_CHUNK_SIZE + 1)}\n`;
    const secondText = `${"b".repeat(TEXT_CHUNK_SIZE + 1)}\n`;
    const first = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(firstText).buffer as ArrayBuffer,
      "text/markdown"
    );
    const second = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(secondText).buffer as ArrayBuffer,
      "text/markdown",
      first.revision
    );
    await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode(`${secondText}tail\n`).buffer as ArrayBuffer,
      "text/markdown",
      second.revision
    );

    await runInDurableObject(stub, async (instance: VaultCoordinator, state) => {
      const chunks = state.storage.sql
        .exec(
          `SELECT chunk_idx FROM text_update_chunks
           WHERE path_lower = ? AND to_rev = ?`,
          path.toLowerCase(),
          second.revision
        )
        .toArray();
      expect(chunks.length).toBeGreaterThan(1);
      const store = (
        instance as unknown as {
          textStore: { reconstruct(path: string, revision: number): string | null };
        }
      ).textStore;
      expect(store.reconstruct(path, second.revision)).toBe(secondText);
    });
  });

  it("advances checkpoints when a device acks the current head", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "acked.md";
    const first = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("first").buffer as ArrayBuffer,
      "text/markdown"
    );
    const second = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("second").buffer as ArrayBuffer,
      "text/markdown",
      first.revision
    );

    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(`SELECT to_rev FROM text_updates WHERE path_lower = ?`, path.toLowerCase())
          .toArray()
      ).toHaveLength(1);
    });

    await stub.recordAcks(vaultId, "plugin:test", {
      acks: [{ path, revision: second.revision }],
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const checkpoint = state.storage.sql
        .exec<{ revision: number }>(
          `SELECT revision FROM text_checkpoints WHERE path_lower = ?`,
          path.toLowerCase()
        )
        .toArray()[0];
      expect(checkpoint.revision).toBe(second.revision);
      expect(
        state.storage.sql
          .exec(`SELECT to_rev FROM text_updates WHERE path_lower = ?`, path.toLowerCase())
          .toArray()
      ).toHaveLength(0);
    });
  });

  it("keeps history at the slowest retained device and expires web acks", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "retention.md";
    const entries: ManifestEntry[] = [];
    for (const text of ["one", "two", "three"]) {
      entries.push(
        await stub.syncPutFile(
          vaultId,
          path,
          new TextEncoder().encode(text).buffer as ArrayBuffer,
          "text/markdown",
          entries.at(-1)?.revision
        )
      );
    }

    const now = new Date().toISOString();
    for (const name of ["slow", "fast"]) {
      const id = `${vaultId}-${name}`;
      await env.DB.prepare(
        `INSERT INTO devices
         (id, vault_id, owner_id, device_name, sync_token, created_at, last_seen_at)
         VALUES (?, ?, 'owner-1', ?, ?, ?, ?)`
      )
        .bind(id, vaultId, name, `${vaultId}-${name}`, now, now)
        .run();
    }

    await stub.recordAcks(vaultId, `plugin:${vaultId}-slow`, {
      acks: [{ path, revision: entries[0].revision }],
    });
    await stub.recordAcks(vaultId, `plugin:${vaultId}-fast`, {
      acks: [{ path, revision: entries[2].revision }],
    });
    await stub.recordAcks(vaultId, "web:expired", {
      acks: [{ path, revision: entries[1].revision }],
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const checkpoint = state.storage.sql
        .exec<{ revision: number }>(
          `SELECT revision FROM text_checkpoints WHERE path_lower = ?`,
          path.toLowerCase()
        )
        .one();
      expect(checkpoint.revision).toBe(entries[0].revision);
      state.storage.sql.exec(
        `UPDATE device_acks SET updated_at = ?
         WHERE device_key = 'web:expired' AND path_lower = ?`,
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        path.toLowerCase()
      );
    });

    await stub.recordAcks(vaultId, `plugin:${vaultId}-slow`, {
      acks: [{ path, revision: entries[2].revision }],
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const checkpoint = state.storage.sql
        .exec<{ revision: number }>(
          `SELECT revision FROM text_checkpoints WHERE path_lower = ?`,
          path.toLowerCase()
        )
        .one();
      expect(checkpoint.revision).toBe(entries[2].revision);
      expect(
        state.storage.sql
          .exec(`SELECT to_rev FROM text_updates WHERE path_lower = ?`, path.toLowerCase())
          .toArray()
      ).toHaveLength(0);
    });
  });

  it("creates a conflict note when the client's base was garbage-collected", async () => {
    const vaultId = crypto.randomUUID();
    const stub = await initialize(vaultId);
    const path = "gc-conflict.md";
    const first = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("base").buffer as ArrayBuffer,
      "text/markdown"
    );
    const second = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("server").buffer as ArrayBuffer,
      "text/markdown",
      first.revision
    );
    await stub.recordAcks(vaultId, "plugin:test", {
      acks: [{ path, revision: second.revision }],
    });

    const result = await stub.syncPutFile(
      vaultId,
      path,
      new TextEncoder().encode("client").buffer as ArrayBuffer,
      "text/markdown",
      first.revision,
      "plugin:test"
    );

    expect(result.conflictNote).toMatch(/^\.sync-conflicts\//);
    expect(result.conflict).toMatchObject({
      path,
      conflictNote: result.conflictNote,
      serverRevision: second.revision,
      clientBaseRevision: first.revision,
      serverContent: "server",
      clientContent: "client",
    });
    expect(await stub.listConflicts(vaultId)).toEqual([result.conflict]);
    expect(await stub.getStorageMetrics()).toMatchObject({
      openConflicts: 1,
      resolvedConflicts: 0,
      conflictResolveRate: 0,
    });
    const head = await stub.getContent(vaultId, path);
    expect(new TextDecoder().decode(head?.bytes)).toBe("server");
    const note = await stub.getContent(vaultId, result.conflictNote!);
    expect(new TextDecoder().decode(note?.bytes)).toContain("Client Version (not applied)");

    const resolution = await stub.resolveConflict(
      vaultId,
      {
        path,
        conflictNote: result.conflictNote!,
        action: "keep-server",
      },
      "web:test"
    );
    expect(resolution.entry.revision).toBe(second.revision);
    expect(await stub.getContent(vaultId, result.conflictNote!)).toBeNull();
    expect(await stub.listConflicts(vaultId)).toEqual([]);
    expect(await stub.getStorageMetrics()).toMatchObject({
      openConflicts: 0,
      resolvedConflicts: 1,
      conflictResolveRate: 1,
    });
    await expect(
      stub.resolveConflict(vaultId, {
        path,
        conflictNote: result.conflictNote!,
        action: "keep-server",
      })
    ).rejects.toThrow("Conflict not found");
  });

  it("commits keep-client and manual-merge conflict resolutions", async () => {
    for (const action of ["keep-client", "use-merged"] as const) {
      const vaultId = crypto.randomUUID();
      const stub = await initialize(vaultId);
      const path = `${action}.md`;
      const first = await stub.syncPutFile(
        vaultId,
        path,
        new TextEncoder().encode("base").buffer as ArrayBuffer,
        "text/markdown"
      );
      const server = await stub.syncPutFile(
        vaultId,
        path,
        new TextEncoder().encode("server").buffer as ArrayBuffer,
        "text/markdown",
        first.revision
      );
      await stub.recordAcks(vaultId, "plugin:test", {
        acks: [{ path, revision: server.revision }],
      });
      const conflict = await stub.syncPutFile(
        vaultId,
        path,
        new TextEncoder().encode("client").buffer as ArrayBuffer,
        "text/markdown",
        first.revision,
        "plugin:test"
      );
      expect(conflict.conflict).toBeDefined();

      const content = action === "keep-client" ? "client" : "manually merged";
      const resolution = await stub.resolveConflict(vaultId, {
        path,
        conflictNote: conflict.conflict!.conflictNote,
        action,
        content,
      });
      expect(resolution.action).toBe(action);
      const head = await stub.getContent(vaultId, path);
      expect(new TextDecoder().decode(head?.bytes)).toBe(content);
      expect(
        await stub.getContent(vaultId, conflict.conflict!.conflictNote)
      ).toBeNull();
    }
  });

});
