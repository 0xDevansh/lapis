/**
 * Conflict Note helpers — Slice 11.
 *
 * When a three-way merge is unsafe (hasConflicts=true) or a binary file has
 * competing edits, the server creates a Conflict Note under `.sync-conflicts/`
 * instead of overwriting the original file.
 *
 * Conflict Note naming:
 *   .sync-conflicts/<original-filename>-<ISO8601>-<deviceName>.md
 *   e.g. .sync-conflicts/notes/foo-2024-06-01T12-00-00Z-my-phone.md
 *
 * The note includes full context so the vault owner can resolve the conflict
 * from either the Web Vault or a Local Vault.
 */

export interface ConflictContext {
  /** Vault-relative path of the original file. */
  path: string;
  /** Server-current content (text). Undefined for binary files. */
  serverContent?: string;
  /** Client-submitted content (text). Undefined for binary conflicts. */
  clientContent?: string;
  /** Common ancestor content (text). May be undefined if base is unavailable. */
  baseContent?: string;
  /** Server's current revision number. */
  serverRevision: number;
  /** Client's reported base revision. */
  clientBaseRevision: number;
  /** Device name that triggered the conflict. */
  deviceName: string;
  /** ISO 8601 timestamp of when the conflict was detected. */
  timestamp: string;
  /** Whether this is a binary conflict. */
  isBinary?: boolean;
}

/**
 * Compute the vault-relative path for the Conflict Note.
 * The path is stable given the same inputs so callers can look it up.
 */
export function conflictNotePath(ctx: ConflictContext): string {
  // Replace colons and dots in timestamp for filesystem safety
  const safeTs = ctx.timestamp.replace(/:/g, "-").replace(/\./g, "-");
  // Sanitise device name: keep alphanumeric, dash, underscore
  const safeDev = ctx.deviceName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  // Original filename without directory
  const filename = ctx.path.split("/").pop() ?? ctx.path;
  const noteFilename = `${filename}-${safeTs}-${safeDev}.md`;
  // Preserve sub-directory structure under .sync-conflicts/
  const dir = ctx.path.includes("/") ? ctx.path.slice(0, ctx.path.lastIndexOf("/")) : "";
  return dir ? `.sync-conflicts/${dir}/${noteFilename}` : `.sync-conflicts/${noteFilename}`;
}

/**
 * Render the Conflict Note Markdown body.
 * The note is self-contained — everything the owner needs to resolve the
 * conflict is embedded directly in the note.
 */
export function renderConflictNote(ctx: ConflictContext): string {
  const lines: string[] = [];

  // Frontmatter for easy programmatic detection
  lines.push("---");
  lines.push("type: sync-conflict");
  lines.push(`path: "${ctx.path}"`);
  lines.push(`server_revision: ${ctx.serverRevision}`);
  lines.push(`client_base_revision: ${ctx.clientBaseRevision}`);
  lines.push(`device: "${ctx.deviceName}"`);
  lines.push(`timestamp: "${ctx.timestamp}"`);
  lines.push(`binary: ${ctx.isBinary ? "true" : "false"}`);
  lines.push("---");
  lines.push("");

  lines.push(`# Sync Conflict: \`${ctx.path}\``);
  lines.push("");
  lines.push(
    `A sync conflict was detected on **${ctx.timestamp}** from device **${ctx.deviceName}**.`
  );
  lines.push("");
  lines.push(`| | Revision |`);
  lines.push(`|---|---|`);
  lines.push(`| Server (current) | ${ctx.serverRevision} |`);
  lines.push(`| Client base | ${ctx.clientBaseRevision} |`);
  lines.push("");
  lines.push(
    "The original file was **not** overwritten. " +
    "Resolve by choosing a version or merging manually, then delete this conflict note."
  );
  lines.push("");

  if (ctx.isBinary) {
    lines.push("## Binary Conflict");
    lines.push("");
    lines.push(
      "Both the server and the client have different versions of this binary file. " +
      "The server version is preserved at the original path. " +
      "The client version was not applied."
    );
    lines.push("");
    lines.push(`- **Original path (server version):** \`${ctx.path}\``);
    lines.push("");
  } else {
    if (ctx.serverContent !== undefined) {
      lines.push("## Server Version (current)");
      lines.push("");
      lines.push("```");
      lines.push(ctx.serverContent);
      lines.push("```");
      lines.push("");
    }

    if (ctx.clientContent !== undefined) {
      lines.push("## Client Version (not applied)");
      lines.push("");
      lines.push("```");
      lines.push(ctx.clientContent);
      lines.push("```");
      lines.push("");
    }

    if (ctx.baseContent !== undefined) {
      lines.push("## Common Base");
      lines.push("");
      lines.push("```");
      lines.push(ctx.baseContent);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("*Delete this note once the conflict is resolved.*");
  lines.push("");

  return lines.join("\n");
}
