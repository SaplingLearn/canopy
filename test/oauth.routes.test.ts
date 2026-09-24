import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { pkce } from "../src/auth/crypto";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";
import { registerClient, checkAuthorizeRequest, issueAuthorization, exchangeAuthorizationCode } from "../src/auth/oauth";
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
