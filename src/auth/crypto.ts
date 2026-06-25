// Web Crypto helpers for auth. No external dependencies.
const enc = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** URL-safe random token with `bytes` of entropy (default 32 -> 43 base64url chars). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

/** A PKCE verifier (within the allowed charset) and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Seal a value as `value.sigBase64url` (HMAC-SHA256). The value must be dot-free for clean unsealing. */
export async function hmacSeal(value: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${toBase64Url(sig)}`;
}

/** Verify and open a sealed value; null if malformed, tampered, or signed with another secret. */
export async function hmacUnseal(sealed: string, secret: string): Promise<string | null> {
  const i = sealed.lastIndexOf(".");
  if (i < 0) return null;
  const value = sealed.slice(0, i);
  const expected = await hmacSeal(value, secret);
  return expected === sealed ? value : null;
}

/** AES-256-GCM key derived from a secret (SHA-256 → 32-byte key). */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seal a secret value at rest: base64url(iv ‖ AES-GCM ciphertext). */
export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return toBase64Url(packed);
}

/** Open a sealed secret; null if malformed, tampered, or sealed with another secret. */
export async function decryptSecret(sealed: string, secret: string): Promise<string | null> {
  try {
    const packed = fromBase64Url(sealed);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(secret), ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
