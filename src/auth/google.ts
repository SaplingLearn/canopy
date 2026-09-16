import type { Env } from "../env";
import { b64uDecode, b64uToBytes } from "./crypto";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleProfile { sub: string; email: string; email_verified: boolean; name: string | null; picture: string | null }

export function buildGoogleAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string; prompt?: string }): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  if (o.prompt) u.searchParams.set("prompt", o.prompt);
  return u.toString();
}

/** Exchange the code (+ PKCE verifier) for the ID token; null on failure. */
export async function exchangeGoogleCode(o: { env: Env; code: string; redirectUri: string; verifier: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const f = o.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: o.env.GOOGLE_CLIENT_ID ?? "", client_secret: o.env.GOOGLE_CLIENT_SECRET ?? "",
    code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, grant_type: "authorization_code",
  });
  const res = await f(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!res.ok) return null;
  const data = (await res.json()) as { id_token?: string };
  return data.id_token ?? null;
}

interface Jwk { kid?: string; kty: string; n: string; e: string; alg?: string }

/** Verify signature (RS256 against Google's JWKS), iss, aud, exp. Returns the profile claims or null. */
export async function verifyGoogleIdToken(idToken: string, o: { clientId: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<GoogleProfile | null> {
  // Defensive top-level try/catch: this function must never throw (a malformed
  // token, a malformed JWKS response, or a WebCrypto rejection all resolve to
  // null, same as any other verification failure) — callers treat null as
  // "not authenticated", never as an exception to handle.
  try {
    const f = o.fetchImpl ?? fetch;
    const now = (o.now ?? Date.now)();
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64uDecode(parts[0])) as { alg?: string; kid?: string } | null;
    const claims = JSON.parse(b64uDecode(parts[1])) as Record<string, unknown> | null;
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return null;
    if (header.alg !== "RS256" || !header.kid) return null;

    const res = await f(JWKS, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const { keys } = (await res.json()) as { keys: Jwk[] };
    const jwk = Array.isArray(keys) ? keys.find((k) => k.kid === header.kid) : undefined;
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;

    if (!ISSUERS.has(String(claims.iss))) return null;
    if (claims.aud !== o.clientId) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
    return {
      sub: claims.sub, email: claims.email, email_verified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : null,
      picture: typeof claims.picture === "string" ? claims.picture : null,
    };
  } catch {
    return null;
  }
}
