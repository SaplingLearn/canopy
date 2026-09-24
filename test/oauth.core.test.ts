import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import {
  oauthOrigin, mcpResource, protectedResourceMetadata, authorizationServerMetadata,
  isAllowedRedirectUri, redirectMatches, validateRegistration, registerClient, getClient, OAuthError,
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
