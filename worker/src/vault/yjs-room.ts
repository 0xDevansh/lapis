import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { appendUpdate, compactYDoc, loadYDoc } from "./yjs/persist";
import { handleSyncMessage, MSG_SYNC, writeSyncStep1, writeUpdate } from "./yjs/protocol";
import { materializeManifest, type ManifestFile } from "./yjs/schema";

export type YjsConnRole = "editor" | "viewer";

type Attached = WebSocket & {
  serializeAttachment(value: { canWrite: boolean }): void;
  deserializeAttachment(): { canWrite: boolean } | undefined;
};

const COMPACT_EVERY_N_UPDATES = 50;
const DEBOUNCE_MS = 2_000;

/**
 * Yjs sync room hosted inside a Durable Object.
 * Binary WebSocket frames carry y-websocket-style sync messages.
 */
export class YjsRoom {
  private doc: Y.Doc | null = null;
  private updateCount = 0;
  private persistOrigin = "do-persist";
  private debounceDeadline: number | null = null;
  private onDebounced: (() => void) | null = null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly getSockets: () => WebSocket[],
    private readonly scheduleAlarm: (at: number) => Promise<void>
  ) {}

  setDebounceHandler(fn: () => void): void {
    this.onDebounced = fn;
  }

  ensureDoc(): Y.Doc {
    if (this.doc) return this.doc;
    this.doc = loadYDoc(this.sql);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.persistOrigin) return;
      appendUpdate(this.sql, update);
      this.updateCount += 1;
      if (this.updateCount >= COMPACT_EVERY_N_UPDATES) {
        compactYDoc(this.sql, this.doc!);
        this.updateCount = 0;
      }
      this.broadcastUpdate(update, origin);
      void this.armDebounce();
    });
    return this.doc;
  }

  getDoc(): Y.Doc {
    return this.ensureDoc();
  }

  manifest(): ManifestFile[] {
    return materializeManifest(this.ensureDoc());
  }

  compact(): void {
    compactYDoc(this.sql, this.ensureDoc());
    this.updateCount = 0;
  }

  acceptClient(server: WebSocket, canWrite: boolean): void {
    const attached = server as Attached;
    attached.serializeAttachment({ canWrite });
    const doc = this.ensureDoc();
    const encoder = encoding.createEncoder();
    writeSyncStep1(encoder, doc);
    server.send(encoding.toUint8Array(encoder));
  }

  handleMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === "string") return;
    const attached = ws as Attached;
    const meta = attached.deserializeAttachment() ?? { canWrite: false };
    const bytes = new Uint8Array(message);
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MSG_SYNC) return;

    // Peek sync subtype: viewers may only send sync step 1 (request state)
    const subtype = decoding.readVarUint(decoder);
    // Rewind by rebuilding decoder — lib0 has no seek; re-decode from start
    const decoder2 = decoding.createDecoder(bytes);
    decoding.readVarUint(decoder2); // MSG_SYNC
    if (subtype === 2 /* update */ && !meta.canWrite) {
      return; // reject writes from viewers
    }

    const encoder = encoding.createEncoder();
    handleSyncMessage(this.ensureDoc(), decoder2, encoder, ws);
    const reply = encoding.toUint8Array(encoder);
    // Only send if more than the MSG_SYNC prefix was written
    if (reply.byteLength > 1) {
      try {
        ws.send(reply);
      } catch {
        /* closed */
      }
    }
  }

  private broadcastUpdate(update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    writeUpdate(encoder, update);
    const payload = encoding.toUint8Array(encoder);
    for (const ws of this.getSockets()) {
      if (origin === ws) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private async armDebounce(): Promise<void> {
    const at = Date.now() + DEBOUNCE_MS;
    this.debounceDeadline = at;
    await this.scheduleAlarm(at);
  }

  /** Call from DO alarm — returns true if debounce fired. */
  maybeRunDebounced(): boolean {
    if (this.debounceDeadline === null) return false;
    if (Date.now() < this.debounceDeadline) return false;
    this.debounceDeadline = null;
    this.compact();
    this.onDebounced?.();
    return true;
  }
}
