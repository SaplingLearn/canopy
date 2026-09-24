import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { pkce } from "../src/auth/crypto";
import { seedPerson } from "./helpers/persons";
import {
  oauthOrigin, mcpResource, protectedResourceMetadata, authorizationServerMetadata,
  isAllowedRedirectUri, redirectMatches, validateRegistration, registerClient, getClient, OAuthError,
  checkAuthorizeRequest, issueAuthorization, exchangeAuthorizationCode, resolveOAuthAccessToken,
  canonicalAuthorizeQuery, type RegisteredClient,
} from "../src/auth/oauth";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

describe("0029_oauth schema", () => {
  it("creates the four oauth tables", async () => {
    const rows = await all<{ name: string }>(env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(["oauth_clients", "oauth_codes", "oauth_grants", "oauth_tokens"]);
  });
});

describe("oauthOrigin", () => {
  it("forces https for public hosts and keeps http for local dev", () => {
    expect(oauthOrigin("http://canopy.saplinglearn.com/mcp")).toBe("https://canopy.saplinglearn.com");
    expect(oauthOrigin("http://localhost:8787/mcp")).toBe("http://localhost:8787");
    expect(oauthOrigin("http://127.0.0.1:8787/x")).toBe("http://127.0.0.1:8787");
  });
});

describe("metadata", () => {
  it("protected resource names /mcp and this origin as its authorization server", () => {
    expect(protectedResourceMetadata("https://c.test")).toEqual({
      resource: "https://c.test/mcp", authorization_servers: ["https://c.test"],
      scopes_supported: ["mcp"], bearer_methods_supported: ["header"],
    });
    expect(mcpResource("https://c.test")).toBe("https://c.test/mcp");
  });
  it("authorization server lists the endpoints, S256 only, public clients only", () => {
    const m = authorizationServerMetadata("https://c.test");
    expect(m).toEqual({
      issuer: "https://c.test",
      authorization_endpoint: "https://c.test/oauth/authorize",
      token_endpoint: "https://c.test/oauth/token",
      registration_endpoint: "https://c.test/oauth/register",
      revocation_endpoint: "https://c.test/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });
});

describe("redirect URIs", () => {
  it("allows https and loopback http; refuses other http, fragments, junk", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:5000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
  it("https matches exactly; a loopback http redirect matches on any port (RFC 8252)", () => {
    const reg = ["http://localhost:1111/callback", "https://claude.ai/cb"];
    expect(redirectMatches(reg, "https://claude.ai/cb")).toBe(true);
    expect(redirectMatches(reg, "https://claude.ai/cb2")).toBe(false);
    expect(redirectMatches(reg, "http://localhost:2222/callback")).toBe(true);
    expect(redirectMatches(reg, "http://localhost:2222/other")).toBe(false);
    expect(redirectMatches(reg, "http://127.0.0.1:1111/callback")).toBe(false); // host must match
    expect(redirectMatches(["https://a.test:1/cb"], "https://a.test:2/cb")).toBe(false); // https: exact
  });
});

describe("validateRegistration", () => {
  const ok = { client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] };
  it("accepts a minimal public client and defaults / trims / cuts the name", () => {
    expect(validateRegistration(ok)).toEqual({ client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] });
    expect(validateRegistration({ redirect_uris: ok.redirect_uris }).client_name).toBe("Unnamed client");
    expect(validateRegistration({ ...ok, client_name: "  x  " }).client_name).toBe("x");
    expect(validateRegistration({ ...ok, client_name: "y".repeat(200) }).client_name).toHaveLength(80);
    expect(validateRegistration({ ...ok, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })).toBeTruthy();
  });
  it.each([
    ["not an object", "nope"],
    ["array body", []],
    ["no redirect_uris", { client_name: "x" }],
    ["empty redirect_uris", { redirect_uris: [] }],
    ["six redirect_uris", { redirect_uris: Array.from({ length: 6 }, (_, i) => `http://localhost:${i + 1}/cb`) }],
    ["non-loopback http", { redirect_uris: ["http://evil.example/cb"] }],
    ["confidential client", { ...ok, token_endpoint_auth_method: "client_secret_basic" }],
    ["unsupported grant", { ...ok, grant_types: ["client_credentials"] }],
    ["unsupported response type", { ...ok, response_types: ["token"] }],
  ])("rejects %s with invalid_client_metadata", (_label, body) => {
    try { validateRegistration(body); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(OAuthError); expect((e as OAuthError).code).toBe("invalid_client_metadata"); expect((e as OAuthError).status).toBe(400); }
  });
});

describe("registerClient / getClient", () => {
  it("stores a client and reads it back with its redirect list", async () => {
    const c = await registerClient(env.DB, { client_name: "Claude Code", redirect_uris: ["http://localhost:1/callback"] }, NOW);
    expect(c.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getClient(env.DB, c.client_id)).toEqual(c);
    expect((await first<{ created_at: string }>(env.DB, `SELECT created_at FROM oauth_clients WHERE client_id = ?`, c.client_id))?.created_at).toBe("2026-09-24T12:00:00.000Z");
    expect(await getClient(env.DB, "nope")).toBeNull();
  });
});

const ORIGIN = "https://canopy.test";
const REDIRECT = "http://localhost:4444/callback";

async function client(): Promise<RegisteredClient> {
  return registerClient(env.DB, { client_name: "Claude Code", redirect_uris: [REDIRECT] }, NOW);
}
function authQuery(c: RegisteredClient, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "st-1", ...extra,
  });
}
/** Register, consent as `person`, and return what a client holds after the redirect. */
async function authorized(person = "real-user", extra: Record<string, string> = {}) {
  await seedPerson(person);
  const c = await client();
  const { verifier, challenge } = await pkce();
  const check = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, extra), ORIGIN);
  if (!check.ok) throw new Error("expected ok");
  const { code, grantId } = await issueAuthorization(env.DB, { client: c, params: check.params, person, nowMs: NOW });
  return { c, verifier, code, grantId };
}

describe("checkAuthorizeRequest", () => {
  it("accepts a well-formed request", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, { resource: `${ORIGIN}/mcp`, scope: "mcp" }), ORIGIN);
    expect(r).toEqual({ ok: true, client: c, params: { client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, state: "st-1", resource: `${ORIGIN}/mcp` } });
  });
  it("unknown client or unregistered redirect → an error PAGE, never a redirect", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const unknown = await checkAuthorizeRequest(env.DB, authQuery({ ...c, client_id: "nope" }, challenge), ORIGIN);
    expect(unknown).toMatchObject({ ok: false, kind: "page" });
    const q = authQuery(c, challenge); q.set("redirect_uri", "https://evil.example/cb");
    expect(await checkAuthorizeRequest(env.DB, q, ORIGIN)).toMatchObject({ ok: false, kind: "page" });
  });
  it("loopback redirect matches on any port", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const q = authQuery(c, challenge); q.set("redirect_uri", "http://localhost:9999/callback");
    const r = await checkAuthorizeRequest(env.DB, q, ORIGIN);
    expect(r.ok && r.params.redirect_uri).toBe("http://localhost:9999/callback");
  });
  it.each([
    ["response_type", { response_type: "token" }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["short challenge", { code_challenge: "abc" }],
    ["foreign resource", { resource: "https://other.test/mcp" }],
    ["oversized state", { state: "s".repeat(1025) }],
  ])("%s → invalid_request redirect carrying state", async (_l, extra) => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, extra), ORIGIN);
    expect(r).toMatchObject({ ok: false, kind: "redirect", redirect_uri: REDIRECT });
  });
  it("resource with trailing slash is the same resource; an unknown scope is ignored", async () => {
    const c = await client();
    const { challenge } = await pkce();
    const r = await checkAuthorizeRequest(env.DB, authQuery(c, challenge, { resource: `${ORIGIN}/mcp/`, scope: "claudeai offline_access" }), ORIGIN);
    expect(r.ok).toBe(true);
  });
  it("canonicalAuthorizeQuery keeps only the authorize keys, in a fixed order, skipping empties", () => {
    const q = new URLSearchParams({ state: "s", junk: "x", client_id: "c", response_type: "code", scope: "" });
    expect(canonicalAuthorizeQuery(q)).toBe("response_type=code&client_id=c&state=s");
  });
});

describe("code exchange", () => {
  it("swaps a code + verifier for a token pair that resolves to the person", async () => {
    const { c, verifier, code } = await authorized();
    const t = await exchangeAuthorizationCode(env.DB, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null }, ORIGIN, NOW + 1000);
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(t.access_token.startsWith("canopy_oat_")).toBe(true);
    expect(t.refresh_token.startsWith("canopy_ort_")).toBe(true);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 2000)).toEqual({ handle: "real-user" });
    // hashes only
    expect(await first(env.DB, `SELECT 1 AS x FROM oauth_tokens WHERE token_hash IN (?, ?)`, t.access_token, t.refresh_token)).toBeNull();
  });
  it("a code works once", async () => {
    const { c, verifier, code } = await authorized();
    const req = { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null };
    await exchangeAuthorizationCode(env.DB, req, ORIGIN, NOW + 1000);
    await expect(exchangeAuthorizationCode(env.DB, req, ORIGIN, NOW + 2000)).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("rejects an expired code, a wrong verifier, and a redirect/client/resource mismatch — and burns the code", async () => {
    const cases: Array<(a: Awaited<ReturnType<typeof authorized>>) => Parameters<typeof exchangeAuthorizationCode>[1]> = [
      (a) => ({ code: a.code, code_verifier: "x".repeat(43), redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: "http://localhost:5555/callback", client_id: a.c.client_id, resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: "other", resource: null }),
      (a) => ({ code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: "https://other.test/mcp" }),
    ];
    for (const [i, make] of cases.entries()) {
      const a = await authorized(`p-case-${i}`);
      await expect(exchangeAuthorizationCode(env.DB, make(a), ORIGIN, NOW + 1000)).rejects.toMatchObject({ code: "invalid_grant" });
      const good = { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null };
      await expect(exchangeAuthorizationCode(env.DB, good, ORIGIN, NOW + 2000)).rejects.toMatchObject({ code: "invalid_grant" });
    }
    const late = await authorized("p-late");
    await expect(exchangeAuthorizationCode(env.DB, { code: late.code, code_verifier: late.verifier, redirect_uri: REDIRECT, client_id: late.c.client_id, resource: null }, ORIGIN, NOW + 61_000))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("a code on a grant revoked before the exchange is refused", async () => {
    const a = await authorized();
    await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = 't', revoked_reason = 'user' WHERE id = ?`).bind(a.grantId).run();
    await expect(exchangeAuthorizationCode(env.DB, { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }, ORIGIN, NOW + 1000))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("resolveOAuthAccessToken", () => {
  it("expires after an hour, stops on a revoked grant, and throttles last_used_at", async () => {
    const a = await authorized();
    const t = await exchangeAuthorizationCode(env.DB, { code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.c.client_id, resource: null }, ORIGIN, NOW);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 1000)).toEqual({ handle: "real-user" });
    const used1 = (await first<{ last_used_at: string }>(env.DB, `SELECT last_used_at FROM oauth_grants WHERE id = ?`, a.grantId))!.last_used_at;
    expect(used1).toBe(new Date(NOW + 1000).toISOString());
    await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 30_000); // inside the throttle: no write
    expect((await first<{ last_used_at: string }>(env.DB, `SELECT last_used_at FROM oauth_grants WHERE id = ?`, a.grantId))!.last_used_at).toBe(used1);
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 3_600_000)).toBeNull();
    await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = 't' WHERE id = ?`).bind(a.grantId).run();
    expect(await resolveOAuthAccessToken(env.DB, t.access_token, NOW + 2000)).toBeNull();
    expect(await resolveOAuthAccessToken(env.DB, t.refresh_token, NOW + 2000)).toBeNull(); // a refresh token is never a bearer
    expect(await resolveOAuthAccessToken(env.DB, "canopy_oat_unknown", NOW)).toBeNull();
  });
});
