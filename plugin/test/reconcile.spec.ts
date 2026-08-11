import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextDelta } from "../src/sync/text-delta";
import { emptyFsIndex, planReconcile } from "../src/sync/reconcile";

describe("applyTextDelta", () => {
  it("no-ops when equal", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "hello");
    applyTextDelta(text, "hello");
    expect(text.toString()).toBe("hello");
  });

  it("replaces a middle segment", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "hello world");
    applyTextDelta(text, "hello there");
    expect(text.toString()).toBe("hello there");
  });

  it("handles append", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "ab");
    applyTextDelta(text, "abcd");
    expect(text.toString()).toBe("abcd");
  });
});

describe("planReconcile", () => {
  it("detects modify on same path", () => {
    const index = emptyFsIndex("v1");
    index.pathToId["a.md"] = "id1";
    index.idToHash["id1"] = "hashA";
    index.idToPath["id1"] = "a.md";

    const ops = planReconcile(index, [{ path: "a.md", hash: "hashB", kind: "text" }]);
    expect(ops).toEqual([
      { op: "modify", fileId: "id1", path: "a.md", hash: "hashB", kind: "text" },
    ]);
  });

  it("detects rename via unique hash match when path changes off-session", () => {
    const index = emptyFsIndex("v1");
    index.pathToId["old.md"] = "id1";
    index.idToHash["id1"] = "samehash";
    index.idToPath["id1"] = "old.md";

    const ops = planReconcile(index, [{ path: "new.md", hash: "samehash", kind: "text" }]);
    expect(ops).toEqual([
      {
        op: "rename",
        fileId: "id1",
        oldPath: "old.md",
        newPath: "new.md",
        hash: "samehash",
      },
    ]);
  });

  it("falls back to delete+create when hashes do not uniquely match", () => {
    const index = emptyFsIndex("v1");
    index.pathToId["old.md"] = "id1";
    index.idToHash["id1"] = "h1";
    index.idToPath["id1"] = "old.md";

    const ops = planReconcile(index, [{ path: "new.md", hash: "h2", kind: "text" }]);
    expect(ops).toContainEqual({ op: "delete", fileId: "id1", path: "old.md" });
    expect(ops).toContainEqual({ op: "create", path: "new.md", hash: "h2", kind: "text" });
  });

  it("no-ops when unchanged", () => {
    const index = emptyFsIndex("v1");
    index.pathToId["a.md"] = "id1";
    index.idToHash["id1"] = "h";
    index.idToPath["id1"] = "a.md";
    expect(planReconcile(index, [{ path: "a.md", hash: "h", kind: "text" }])).toEqual([]);
  });
});
