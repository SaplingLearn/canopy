import { b64uEncode } from "../../src/auth/crypto";

export interface GoogleKeys { priv: CryptoKey; jwk: JsonWebKey & { kid: string } }

const enc = new TextEncoder();
const b64uBytes = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function makeGoogleKeys(kid = "kid-1"): Promise<GoogleKeys> {
  // @cloudflare/workers-types has a single non-discriminating generateKey()
  // overload (Promise<CryptoKey | CryptoKeyPair>, unlike DOM lib's algorithm-
  // keyed overloads), so the RSA key-pair shape needs an explicit assertion.
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export const CLAIMS = {
  iss: "https://accounts.google.com", aud: "test-google-client-id", sub: "g-123", email: "priya.n@gmail.com", email_verified: true,
  name: "Priya Natarajan", picture: "https://lh3/p.png", iat: 1_800_000_000, exp: 1_800_003_600,
};

export async function signIdToken(keys: GoogleKeys, claims: Record<string, unknown>, kid = keys.jwk.kid): Promise<string> {
  const h = b64uEncode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64uEncode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64uBytes(sig)}`;
}

/** fetchImpl serving Google's JWKS and token endpoint. Records token-endpoint bodies. */
export function googleFetch(keys: GoogleKeys, o: { idToken?: string; tokenStatus?: number } = {}) {
  const tokenCalls: URLSearchParams[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [keys.jwk] }), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify({ id_token: o.idToken ?? "", access_token: "at" }), { status: o.tokenStatus ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected fetch " + u, { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, tokenCalls };
}
