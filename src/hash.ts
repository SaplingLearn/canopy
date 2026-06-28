// Deterministic content hash used by the reconciler to drop no-op writes.
// SHA-256 via Web Crypto (available in the Workers/Miniflare runtime). The same
// function hashes a body on write AND on the dedupe check, so an identical body
// always produces an identical hash.

const enc = new TextEncoder();

export async function contentHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
