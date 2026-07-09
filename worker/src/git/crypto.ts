/**
 * PAT encryption at rest — Slice 25.
 *
 * Uses AES-GCM with a Worker-held key (GITHUB_PAT_ENCRYPTION_KEY).
 * Plaintext PATs are never logged or returned in API responses.
 */

const IV_BYTES = 12;

function keyMaterial(kek: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(kek.padEnd(32, "0").slice(0, 32));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptPat(kek: string, pat: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await keyMaterial(kek);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(pat)
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptPat(kek: string, ciphertextB64: string): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const key = await keyMaterial(kek);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function patLast4(pat: string): string {
  return pat.length <= 4 ? pat : pat.slice(-4);
}
