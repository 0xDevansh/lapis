/**
 * Obsidian plugin Yjs peer — connects to Lapis DO sync endpoint.
 * Full filesystem bridge lands with the engine rewrite; this module
 * owns the wire protocol and local Y.Doc persistence helpers.
 */
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

const MSG_SYNC = 0;

export class PluginYjsClient {
  readonly doc = new Y.Doc();
  private ws: WebSocket | null = null;
  private destroyed = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly onStatus?: (s: "connected" | "disconnected" | "error") => void
  ) {
    this.doc.on("update", this.onLocalUpdate);
  }

  connect(): void {
    if (this.destroyed) return;
    const ws = new WebSocket(this.wsUrl);
    // Obsidian desktop WebSocket supports binary
    (ws as WebSocket & { binaryType?: string }).binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.onStatus?.("connected");
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = event.data;
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(data)) {
        bytes = new Uint8Array(data);
      }
      if (!bytes) return;
      const decoder = decoding.createDecoder(bytes);
      const type = decoding.readVarUint(decoder);
      if (type !== MSG_SYNC) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      const reply = encoding.toUint8Array(encoder);
      if (reply.byteLength > 1 && ws.readyState === WebSocket.OPEN) {
        ws.send(reply);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.onStatus?.("disconnected");
      if (this.destroyed) return;
      this.reconnectTimer = setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        this.connect();
      }, this.backoffMs);
    };

    ws.onerror = () => this.onStatus?.("error");
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off("update", this.onLocalUpdate);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyState(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, "hydrate");
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || origin === "hydrate") return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  };
}

export function yjsWsUrl(serverUrl: string, vaultId: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "");
  const u = new URL(`${base}/api/sync/${vaultId}/yjs`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
}
