/**
 * In-memory filesystem implementation compatible with isomorphic-git.
 *
 * isomorphic-git expects a Node.js-style `fs.promises` interface.
 * Since Cloudflare Workers have no real filesystem, this shim holds
 * files and directories in a Map, keyed by normalized absolute paths.
 *
 * Adapted from the Cloudflare Artifacts isomorphic-git example.
 */

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

class MemoryStats {
  constructor(private readonly entry: Entry) {}

  get size() {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }
  get mtimeMs() { return this.entry.mtimeMs; }
  get ctimeMs() { return this.entry.mtimeMs; }
  get mode() { return this.entry.kind === "file" ? 0o100644 : 0o040000; }

  isFile() { return this.entry.kind === "file"; }
  isDirectory() { return this.entry.kind === "dir"; }
  isSymbolicLink() { return false; }
}

export class MemoryFS {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
    chmod: this.chmod.bind(this),
  };

  // The vault tree never contains symlinks. isomorphic-git's promise-mode
  // FileSystem binds readlink/symlink/chmod unconditionally, so these must
  // exist or `git.init` throws "Cannot read properties of undefined (reading
  // 'bind')". readlink reports "not a symlink"; symlink is unsupported; chmod
  // is a no-op (mode is fixed in MemoryStats).
  async readlink(path: string): Promise<string> {
    throw Object.assign(new Error(`EINVAL: not a symlink, ${path}`), { code: "EINVAL" });
  }

  async symlink(): Promise<void> {
    throw Object.assign(new Error("ENOSYS: symlink not supported"), { code: "ENOSYS" });
  }

  async chmod(): Promise<void> {
    // No-op: MemoryStats reports a fixed mode.
  }

  normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { segments.pop(); continue; }
      segments.push(part);
    }
    return `/${segments.join("/")}` || "/";
  }

  private parentOf(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private requireEntry(path: string): Entry {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return entry;
  }

  private requireDir(path: string): Extract<Entry, { kind: "dir" }> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = typeof options === "object" && options !== null && options.recursive;
    const parent = this.parentOf(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw Object.assign(new Error(`ENOENT: ${parent}`), { code: "ENOENT" });
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parentOf(target), { recursive: true });
    const bytes =
      typeof data === "string" ? this.encoder.encode(data)
      : data instanceof Uint8Array ? data
      : new Uint8Array(data);
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.requireDir(this.parentOf(target)).children.add(this.basename(target));
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    this.entries.delete(target);
    this.requireDir(this.parentOf(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: "ENOTEMPTY" });
    this.entries.delete(target);
    this.requireDir(this.parentOf(target)).children.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }
}
