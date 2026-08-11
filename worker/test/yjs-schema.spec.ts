import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getTextContent,
  listActiveFiles,
  renameFile,
  setTextFile,
  softDeleteFile,
} from "../src/vault/yjs/schema";

describe("yjs vault schema", () => {
  it("creates text files and lists them", () => {
    const doc = new Y.Doc();
    const id = setTextFile(doc, {
      path: "Notes/Hello.md",
      content: "# hi",
      contentType: "text/markdown",
    });
    expect(getTextContent(doc, id)).toBe("# hi");
    const files = listActiveFiles(doc);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("Notes/Hello.md");
  });

  it("renames without changing file id or content", () => {
    const doc = new Y.Doc();
    const id = setTextFile(doc, {
      path: "a.md",
      content: "body",
      contentType: "text/markdown",
    });
    renameFile(doc, id, "b.md");
    expect(getTextContent(doc, id)).toBe("body");
    expect(listActiveFiles(doc)[0].path).toBe("b.md");
  });

  it("soft-delete hides from active list; edit revives", () => {
    const doc = new Y.Doc();
    const id = setTextFile(doc, {
      path: "gone.md",
      content: "x",
      contentType: "text/markdown",
    });
    softDeleteFile(doc, id);
    expect(listActiveFiles(doc)).toHaveLength(0);
    setTextFile(doc, {
      fileId: id,
      path: "gone.md",
      content: "revived",
      contentType: "text/markdown",
    });
    expect(listActiveFiles(doc)).toHaveLength(1);
    expect(getTextContent(doc, id)).toBe("revived");
  });

  it("concurrent rename and edit commute across docs", () => {
    const docA = new Y.Doc();
    const id = setTextFile(docA, {
      path: "note.md",
      content: "one",
      contentType: "text/markdown",
    });
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    renameFile(docA, id, "renamed.md");
    setTextFile(docB, {
      fileId: id,
      path: "note.md",
      content: "two",
      contentType: "text/markdown",
    });

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    expect(getTextContent(docA, id)).toBe("two");
    expect(listActiveFiles(docA)[0].path).toBe("renamed.md");
    expect(getTextContent(docB, id)).toBe("two");
    expect(listActiveFiles(docB)[0].path).toBe("renamed.md");
  });
});
