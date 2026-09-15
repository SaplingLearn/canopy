import { describe, it, expect } from "vitest";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, verifyGoogleIdToken } from "../src/auth/google";
import { makeGoogleKeys, signIdToken, googleFetch, CLAIMS } from "./helpers/google";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";

const NOW = () => 1_800_000_100_000; // ms, inside [iat, exp]

describe("buildGoogleAuthorizeUrl", () => {
  it("targets accounts.google.com with PKCE, openid scopes, and passes login_hint/prompt through", () => {
    const u = new URL(buildGoogleAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/auth/google/callback", state: "st", challenge: "ch", loginHint: "a@b.c", prompt: "select_account" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("ch");
    expect(u.searchParams.get("login_hint")).toBe("a@b.c");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("exchangeGoogleCode", () => {
  it("POSTs the PKCE verifier and returns the id_token; null on non-2xx", async () => {
    const keys = await makeGoogleKeys();
    const { fetchImpl, tokenCalls } = googleFetch(keys, { idToken: "tok" });
    const id = await exchangeGoogleCode({ env: env as unknown as Env, code: "c", redirectUri: "https://x/cb", verifier: "v", fetchImpl });
    expect(id).toBe("tok");
    expect(tokenCalls[0].get("code_verifier")).toBe("v");
    expect(tokenCalls[0].get("grant_type")).toBe("authorization_code");
    const bad = googleFetch(keys, { tokenStatus: 400 });
    expect(await exchangeGoogleCode({ env: env as unknown as Env, code: "c", redirectUri: "https://x/cb", verifier: "v", fetchImpl: bad.fetchImpl })).toBeNull();
  });
});

describe("verifyGoogleIdToken", () => {
  it("accepts a well-formed token signed by the JWKS key", async () => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, CLAIMS);
    const p = await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW });
    expect(p).toEqual({ sub: "g-123", email: "priya.n@gmail.com", email_verified: true, name: "Priya Natarajan", picture: "https://lh3/p.png" });
  });
  it.each([
    ["bad iss", { iss: "https://evil.example" }],
    ["bad aud", { aud: "other-client" }],
    ["expired", { exp: 1_700_000_000 }],
  ])("rejects %s", async (_label, over) => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, { ...CLAIMS, ...over });
    expect(await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
  });
  it("rejects a token signed by another key and an unknown kid", async () => {
    const keys = await makeGoogleKeys();
    const other = await makeGoogleKeys("kid-1"); // same kid, different key
    expect(await verifyGoogleIdToken(await signIdToken(other, CLAIMS), { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
    expect(await verifyGoogleIdToken(await signIdToken(keys, CLAIMS, "kid-unknown"), { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
  });
  it("returns email_verified:false verbatim (the caller gates on it) and accepts the bare 'accounts.google.com' issuer", async () => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, { ...CLAIMS, iss: "accounts.google.com", email_verified: false });
    expect((await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW }))?.email_verified).toBe(false);
  });
});
