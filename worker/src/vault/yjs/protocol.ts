import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/** Outer y-websocket message type: sync */
export const MSG_SYNC = 0;

export const MSG_SYNC_STEP1 = syncProtocol.messageYjsSyncStep1;
export const MSG_SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;
export const MSG_SYNC_UPDATE = syncProtocol.messageYjsUpdate;

export function writeSyncStep1(encoder: encoding.Encoder, doc: Y.Doc): void {
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
}

export function writeSyncStep2(
  encoder: encoding.Encoder,
  doc: Y.Doc,
  encodedStateVector?: Uint8Array
): void {
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, encodedStateVector);
}

export function writeUpdate(encoder: encoding.Encoder, update: Uint8Array): void {
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
}

/**
 * Read a sync sub-message (decoder already past MSG_SYNC) and write the reply
 * sync payload into `encoder` (without the outer MSG_SYNC prefix).
 */
export function readSyncMessage(
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  doc: Y.Doc,
  transactionOrigin: unknown = null
): number {
  return syncProtocol.readSyncMessage(decoder, encoder, doc, transactionOrigin);
}

/**
 * Standard server-side sync handler: assumes `decoder` is positioned at the
 * sync subtype (MSG_SYNC already consumed). Writes MSG_SYNC + reply into `encoder`.
 */
export function handleSyncMessage(
  doc: Y.Doc,
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  transactionOrigin: unknown = null
): void {
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, doc, transactionOrigin);
}
