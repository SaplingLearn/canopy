// MCP OAuth — the HTTP surface over ./oauth.ts. Metadata, register, token and revoke
// are public JSON endpoints with open CORS (no cookies are read); authorize is the
// one route that reads the session, to show the consent page. Never a 500.
import { Hono, type Context } from "hono";
import type { AppEnv } from "./principal";
import {
  OAuthError, oauthOrigin, protectedResourceMetadata, authorizationServerMetadata,
  validateRegistration, registerClient, exchangeAuthorizationCode, refreshAccessToken, revokeOAuthToken,
} from "./oauth";

const MAX_REGISTER_BYTES = 8 * 1024;
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};

export interface OAuthDeps { now?: () => number }

export function buildOAuthApp(deps: OAuthDeps = {}): Hono<AppEnv> {
  const now = deps.now ?? Date.now;
  const o = new Hono<AppEnv>();

  const json = (c: Context<AppEnv>, body: unknown, status: 200 | 201 | 400 | 401 | 503 = 200, cache = "no-store") =>
    c.json(body, status, { ...CORS, "cache-control": cache });
  const oauthError = (c: Context<AppEnv>, e: OAuthError) =>
    json(c, { error: e.code, error_description: e.description }, e.status as 400 | 401);

  // ── Metadata ──
  const prm = (c: Context<AppEnv>) => json(c, protectedResourceMetadata(oauthOrigin(c.req.url)), 200, "public, max-age=3600");
  o.get("/.well-known/oauth-protected-resource", prm);
  o.get("/.well-known/oauth-protected-resource/mcp", prm);
  o.get("/.well-known/oauth-authorization-server", (c) =>
    json(c, authorizationServerMetadata(oauthOrigin(c.req.url)), 200, "public, max-age=3600"));
  const preflight = (c: Context<AppEnv>) => c.body(null, 204, CORS);
  o.options("/.well-known/*", preflight);
  o.options("/oauth/*", preflight);

  // ── Registration ──
  o.post("/oauth/register", async (c) => {
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_REGISTER_BYTES) return oauthError(c, new OAuthError("invalid_client_metadata", "the registration body is over 8 KB"));
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return oauthError(c, new OAuthError("invalid_client_metadata", "the body must be JSON")); }
    try {
      const client = await registerClient(c.env.DB, validateRegistration(body), now());
      return json(c, {
        ...client, client_id_issued_at: Math.floor(now() / 1000), token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      }, 201);
    } catch (e) {
      if (e instanceof OAuthError) return oauthError(c, e);
      console.error("oauth register: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
  });

  /** Form-encoded (the standard) or JSON; string values only. Reads the body as
   *  bytes (not .text()) so a form-urlencoded content-type never trips workerd's
   *  "does not appear to be text" warning. */
  async function params(c: Context<AppEnv>): Promise<URLSearchParams> {
    const text = new TextDecoder().decode(await c.req.arrayBuffer());
    if ((c.req.header("content-type") ?? "").includes("application/json")) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        return new URLSearchParams(Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string"));
      } catch { return new URLSearchParams(); }
    }
    return new URLSearchParams(text);
  }
  const need = (p: URLSearchParams, k: string): string => {
    const v = p.get(k);
    if (!v) throw new OAuthError("invalid_request", `${k} is required`);
    return v;
  };

  // ── Token ──
  o.post("/oauth/token", async (c) => {
    const p = await params(c);
    try {
      const grant = p.get("grant_type");
      if (grant === "authorization_code") {
        return json(c, await exchangeAuthorizationCode(c.env.DB, {
          code: need(p, "code"), code_verifier: need(p, "code_verifier"), redirect_uri: need(p, "redirect_uri"),
          client_id: need(p, "client_id"), resource: p.get("resource"),
        }, oauthOrigin(c.req.url), now()));
      }
      if (grant === "refresh_token") {
        return json(c, await refreshAccessToken(c.env.DB, { refresh_token: need(p, "refresh_token"), client_id: p.get("client_id") }, now()));
      }
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (e) {
      if (e instanceof OAuthError) return oauthError(c, e);
      console.error("oauth token: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
  });

  // ── Revocation (RFC 7009): always 200 on success, never a 500 ──
  o.post("/oauth/revoke", async (c) => {
    const token = (await params(c)).get("token");
    try {
      if (token) await revokeOAuthToken(c.env.DB, token, now());
    } catch (e) {
      console.error("oauth revoke: unexpected error", e instanceof Error ? e.message : "unknown");
      return json(c, { error: "temporarily_unavailable" }, 503);
    }
    return c.body(null, 200, CORS);
  });

  return o;
}

export const oauthApp = buildOAuthApp();
