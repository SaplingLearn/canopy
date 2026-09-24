// MCP OAuth — the authorization server behind /mcp (spec:
// docs/superpowers/specs/2026-09-24-mcp-oauth-design.md). OAuth is how a bearer
// token is OBTAINED; the token then resolves to a person handle exactly like a
// `canopy_mcp_` token, so /mcp stays the bearer auth class. D1 only, no fetch,
// and every clock read is a `nowMs` parameter so tests control time. Raw codes
// and tokens are returned once and stored only as SHA-256 hashes.
import { type DB, first, run } from "../db";
import { randomToken } from "./crypto";

export const ACCESS_PREFIX = "canopy_oat_";
export const REFRESH_PREFIX = "canopy_ort_";
export const OAUTH_SCOPE = "mcp";
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
/** A rotated refresh token presented again inside this window gets a fresh pair
 *  (several Claude Code sessions share one stored credential and can refresh at
 *  once); after it, the reuse revokes the whole grant. */
export const REUSE_INTERVAL_MS = 60 * 1000;
export const LAST_USED_THROTTLE_MS = 60 * 1000;
/** Keeps the sealed `oauth_pending` cookie far below a browser's 4 KB limit. */
export const MAX_STATE_LENGTH = 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME = 80;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const iso = (ms: number): string => new Date(ms).toISOString();

/** A standard OAuth error: `code` is the RFC error string, `status` the HTTP status. */
export class OAuthError extends Error {
  constructor(public code: string, public description: string, public status = 400) {
    super(description);
  }
}

/** This deployment's public origin, from the request. https for every public host
 *  (same rule as callbackUrl in ./routes.ts), http kept only for local dev. */
export function oauthOrigin(reqUrl: string): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return `${isLocal ? u.protocol : "https:"}//${u.host}`;
}

export const mcpResource = (origin: string): string => `${origin}/mcp`;

/** RFC 9728 — what /mcp's 401 points at. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: mcpResource(origin), authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 — Canopy is its own authorization server. */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// ── Registration (RFC 7591, public clients only) ─────────────────────────────

export interface RegisteredClient { client_id: string; client_name: string; redirect_uris: string[] }

function parseUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/** https anywhere, or http on a loopback host; never a fragment. */
export function isAllowedRedirectUri(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u || raw.includes("#")) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/** Exact match — except a loopback http redirect, which matches a registered
 *  loopback URI on host + path + query at ANY port (RFC 8252 §7.3): a native
 *  client such as Claude Code listens on a fresh port each attempt. */
export function redirectMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  const c = parseUrl(candidate);
  if (!c || c.protocol !== "http:" || !LOOPBACK_HOSTS.has(c.hostname)) return false;
  return registered.some((r) => {
    const u = parseUrl(r);
    return !!u && u.protocol === "http:" && u.hostname === c.hostname && u.pathname === c.pathname && u.search === c.search;
  });
}

const badMetadata = (d: string) => new OAuthError("invalid_client_metadata", d);

export function validateRegistration(body: unknown): { client_name: string; redirect_uris: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badMetadata("the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS
    || !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
    throw badMetadata("redirect_uris must be 1-5 https or loopback http URLs without a fragment");
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    throw badMetadata("only public clients are supported (token_endpoint_auth_method: none)");
  }
  if (b.grant_types !== undefined && !(Array.isArray(b.grant_types) && b.grant_types.every((g) => GRANT_TYPES.includes(g as string)))) {
    throw badMetadata("grant_types may only be authorization_code and refresh_token");
  }
  if (b.response_types !== undefined && !(Array.isArray(b.response_types) && b.response_types.every((r) => r === "code"))) {
    throw badMetadata("response_types may only be code");
  }
  const name = typeof b.client_name === "string" ? b.client_name.trim().slice(0, MAX_CLIENT_NAME) : "";
  return { client_name: name || "Unnamed client", redirect_uris: uris as string[] };
}

export async function registerClient(db: DB, meta: { client_name: string; redirect_uris: string[] }, nowMs: number): Promise<RegisteredClient> {
  const client_id = randomToken(32);
  await run(db, `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`,
    client_id, meta.client_name, JSON.stringify(meta.redirect_uris), iso(nowMs));
  return { client_id, client_name: meta.client_name, redirect_uris: meta.redirect_uris };
}

export async function getClient(db: DB, clientId: string): Promise<RegisteredClient | null> {
  const row = await first<{ client_id: string; client_name: string; redirect_uris: string }>(
    db, `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`, clientId);
  if (!row) return null;
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}
