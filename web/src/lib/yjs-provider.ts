import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { getVaultMaps, type VaultMaps } from "./yjs-schema";

const MSG_SYNC = 0;

/**
 * Minimal Yjs WebSocket provider compatible with Lapis DO /yjs endpoint.
 */
export class LapisYjsProvider {
  readonly doc: Y.Doc;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;

  constructor(
    private readonly url: string,
    doc?: Y.Doc
  ) {
    this.doc = doc ?? new Y.Doc();
    this.doc.on("update", this.onLocalUpdate);
    this.connect();
  }

  get maps(): VaultMaps {
    return getVaultMaps(this.doc);
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off("update", this.onLocalUpdate);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect = (): void => {
    if (this.destroyed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));
    };

    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const decoder = decoding.createDecoder(new Uint8Array(event.data));
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
      if (this.destroyed) return;
      this.reconnectTimer = setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        this.connect();
      }, this.backoffMs);
    };
  };

  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  };
}
