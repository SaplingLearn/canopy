import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { pkce } from "../src/auth/crypto";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";
import { registerClient, checkAuthorizeRequest, issueAuthorization, exchangeAuthorizationCode } from "../src/auth/oauth";
import { buildOAuthApp } from "../src/auth/oauth-routes";
import { seedPerson } from "./helpers/persons";
import type { Env } from "../src/env";

const REDIRECT = "http://localhost:4444/callback";
const bearer = (t: string) => new Request("https://example.com/mcp", { headers: { authorization: `Bearer ${t}` } });

async function oauthAccessToken(person: string): Promise<string> {
  await seedPerson(person);
  const c = await registerClient(env.DB, { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
  const { verifier, challenge } = await pkce();
  const check = await checkAuthorizeRequest(env.DB, new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
  }), "https://example.com");
  if (!check.ok) throw new Error("expected ok");
  const { code } = await issueAuthorization(env.DB, { client: c, params: check.params, person, nowMs: Date.now() });
  const t = await exchangeAuthorizationCode(env.DB, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id, resource: null }, "https://example.com", Date.now());
  return t.access_token;
}

describe("bearer dispatch", () => {
  it("an OAuth access token and a canopy_mcp_ token both resolve to their person", async () => {
    const oat = await oauthAccessToken("oauth-user");
    expect(await resolveBearerPrincipal(bearer(oat), env as unknown as Env)).toEqual({ handle: "oauth-user" });
    await seedPerson("token-user");
    const { raw } = await mintToken(env.DB, "token-user");
    expect(await resolveBearerPrincipal(bearer(raw), env as unknown as Env)).toEqual({ handle: "token-user" });
  });
  it("/mcp lets an OAuth access token through (not a 401)", async () => {
    const oat = await oauthAccessToken("oauth-user");
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${oat}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(res.status).not.toBe(401);
  });
});

const form = (o: Record<string, string>) => ({
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(),
});

describe("metadata endpoints", () => {
  it("serve both documents publicly with CORS, including the /mcp-suffixed form", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await SELF.fetch(`https://example.com${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await r.json()) as { resource: string }).resource).toBe("https://example.com/mcp");
    }
    const as = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
    expect(((await as.json()) as { token_endpoint: string }).token_endpoint).toBe("https://example.com/oauth/token");
    const pre = await SELF.fetch("https://example.com/oauth/token", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("POST /oauth/register", () => {
  it("201 with a client_id for a valid public client", async () => {
    const r = await SELF.fetch("https://example.com/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(typeof b.client_id).toBe("string");
  });
  it("400 invalid_client_metadata on bad JSON, a bad redirect, or a body over 8 KB — writing nothing", async () => {
    const bodies = ["{nope", JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }), JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(9000) })];
    for (const body of bodies) {
      const r = await SELF.fetch("https://example.com/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).first<{ n: number }>())?.n).toBe(0);
  });
  it("400 invalid_client_metadata when multi-byte content pushes the body over 8 KB in bytes, under 8 KB in characters", async () => {
    const body = JSON.stringify({ redirect_uris: [REDIRECT], client_name: "€".repeat(3000) }); // 3000 chars, ~9000 UTF-8 bytes
    expect(body.length).toBeLessThan(8192);
    const r = await SELF.fetch("https://example.com/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });
});

describe("POST /oauth/token", () => {
  async function codeFor(person: string) {
    await seedPerson(person);
    const c = await registerClient(env.DB, { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
    const { verifier, challenge } = await pkce();
    const check = await checkAuthorizeRequest(env.DB, new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
    }), "https://example.com");
    if (!check.ok) throw new Error("expected ok");
    const { code } = await issueAuthorization(env.DB, { client: c, params: check.params, person, nowMs: Date.now() });
    return { c, verifier, code };
  }
  it("authorization_code then refresh_token, form-encoded; no-store; CORS", async () => {
    const { c, verifier, code } = await codeFor("oauth-user");
    const r = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const t = (await r.json()) as { access_token: string; refresh_token: string };
    const r2 = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { access_token: string }).access_token).not.toBe(t.access_token);
  });
  it("accepts a JSON body too", async () => {
    const { c, verifier, code } = await codeFor("oauth-user");
    const r = await SELF.fetch("https://example.com/oauth/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }),
    });
    expect(r.status).toBe(200);
  });
  it("standard errors: missing param, bad code, unsupported grant", async () => {
    const miss = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code: "x" }));
    expect(miss.status).toBe(400);
    expect(((await miss.json()) as { error: string }).error).toBe("invalid_request");
    const bad = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "authorization_code", code: "x", code_verifier: "v", redirect_uri: REDIRECT, client_id: "c" }));
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    const un = await SELF.fetch("https://example.com/oauth/token", form({ grant_type: "password" }));
    expect(((await un.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });
});

describe("POST /oauth/revoke", () => {
  it("always 200, and a revoked access token stops working on /mcp", async () => {
    const oat = await oauthAccessToken("oauth-user");
    expect((await SELF.fetch("https://example.com/oauth/revoke", form({ token: oat }))).status).toBe(200);
    expect((await SELF.fetch("https://example.com/oauth/revoke", form({ token: "junk" }))).status).toBe(200);
    expect(await resolveBearerPrincipal(bearer(oat), env as unknown as Env)).toBeNull();
  });
});

describe("never a 500", () => {
  // A DB that throws on every prepare() stands in for an unexpected D1 failure —
  // register and revoke must both answer 503, never let the throw escape as Hono's
  // plain-text 500.
  const throwingEnv = { ...env, DB: { prepare() { throw new Error("d1 down"); } } } as unknown as Env;

  it("register: an unexpected DB throw is a 503 temporarily_unavailable, not a 500", async () => {
    const r = await buildOAuthApp().request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
    }, throwingEnv);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("revoke: an unexpected DB throw is a 503, not a 500", async () => {
    const r = await buildOAuthApp().request("/oauth/revoke", form({ token: "whatever" }), throwingEnv);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "temporarily_unavailable" });
  });
});
