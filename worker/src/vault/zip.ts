/**
 * Minimal ZIP builder for Cloudflare Workers — Slice 13.
 *
 * Produces uncompressed (STORE method) ZIP archives.  All files are stored
 * without compression so that no native deflate bindings are required, and
 * the archive is still fully readable by every OS unzip utility.
 *
 * Spec reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * (PKZIP Application Note, sections 4.3.x).
 */

/** A single entry to include in the ZIP. */
export interface ZipEntry {
  /** Path as it should appear inside the ZIP (forward-slash separated). */
  path: string;
  /** Raw bytes of the file content. */
  data: Uint8Array;
}

/** Build a ZIP archive in memory and return it as a Uint8Array. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localHeaders: Uint8Array[] = [];
  const centralDirs: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;

    // ── Local file header (30 + n bytes) ────────────────────────────────────
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);  // Local file header signature
    lv.setUint16(4, 20, true);           // Version needed: 2.0
    lv.setUint16(6, 0, true);            // General purpose bit flag
    lv.setUint16(8, 0, true);            // Compression method: STORE
    lv.setUint16(10, 0, true);           // Last mod time
    lv.setUint16(12, 0, true);           // Last mod date
    lv.setUint32(14, crc, true);         // CRC-32
    lv.setUint32(18, size, true);        // Compressed size
    lv.setUint32(22, size, true);        // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // File name length
    lv.setUint16(28, 0, true);           // Extra field length
    local.set(nameBytes, 30);

    // ── Central directory entry (46 + n bytes) ──────────────────────────────
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);  // Central directory signature
    cv.setUint16(4, 20, true);           // Version made by
    cv.setUint16(6, 20, true);           // Version needed
    cv.setUint16(8, 0, true);            // General purpose bit flag
    cv.setUint16(10, 0, true);           // Compression method: STORE
    cv.setUint16(12, 0, true);           // Last mod time
    cv.setUint16(14, 0, true);           // Last mod date
    cv.setUint32(16, crc, true);         // CRC-32
    cv.setUint32(20, size, true);        // Compressed size
    cv.setUint32(24, size, true);        // Uncompressed size
    cv.setUint16(28, nameBytes.length, true); // File name length
    cv.setUint16(30, 0, true);           // Extra field length
    cv.setUint16(32, 0, true);           // File comment length
    cv.setUint16(34, 0, true);           // Disk number start
    cv.setUint16(36, 0, true);           // Internal file attributes
    cv.setUint32(38, 0, true);           // External file attributes
    cv.setUint32(42, offset, true);      // Relative offset of local header
    central.set(nameBytes, 46);

    localHeaders.push(local);
    localHeaders.push(entry.data);
    centralDirs.push(central);

    offset += local.byteLength + entry.data.byteLength;
  }

  // ── End of central directory record ─────────────────────────────────────
  const centralDirSize = centralDirs.reduce((s, c) => s + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);   // End of central directory signature
  ev.setUint16(4, 0, true);             // Disk number
  ev.setUint16(6, 0, true);             // Start disk
  ev.setUint16(8, entries.length, true); // Entries on this disk
  ev.setUint16(10, entries.length, true); // Total entries
  ev.setUint32(12, centralDirSize, true); // Central dir size
  ev.setUint32(16, offset, true);        // Central dir offset
  ev.setUint16(20, 0, true);             // Comment length

  // ── Concatenate everything ───────────────────────────────────────────────
  const totalSize =
    localHeaders.reduce((s, b) => s + b.byteLength, 0) +
    centralDirSize +
    eocd.byteLength;

  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const b of localHeaders) {
    out.set(b, pos);
    pos += b.byteLength;
  }
  for (const b of centralDirs) {
    out.set(b, pos);
    pos += b.byteLength;
  }
  out.set(eocd, pos);

  return out;
}

// ── CRC-32 ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
