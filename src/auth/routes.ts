import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import { isAdmin } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, isActiveOrgMember } from "./github";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken } from "./tokens";
import { first, run, nowIso } from "../db";
import { SAPLING_ORG } from "./github";

const OAUTH_TX_COOKIE = "oauth_tx";

/**
 * The OAuth callback URL for this request. GitHub requires an https callback for public
 * hosts (http is only valid for localhost), so we force https for everything except local
 * dev. Without this, a request that reached the Worker over http (e.g. before an edge
 * http->https upgrade, or a bare-hostname browser navigation) would emit an http
 * redirect_uri that GitHub rejects with "redirect_uri is not associated with this application".
 * The same value is used for the authorize redirect and the token exchange, so they always match.
 */
export function callbackUrl(reqUrl: string): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme = isLocal ? u.protocol.replace(/:$/, "") : "https";
  return `${scheme}://${u.host}/auth/callback`;
}

export const authApp = new Hono<AppEnv>();

// PUBLIC: start the OAuth dance.
authApp.get("/login", async (c) => {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return c.redirect(
    buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: callbackUrl(c.req.url), state, challenge }),
    302
  );
});

// PUBLIC: finish the OAuth dance; create a session only for active org members.
authApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const sealedTx = getCookie(c, OAUTH_TX_COOKIE);
  deleteCookie(c, OAUTH_TX_COOKIE, { path: "/" });
  if (!code || !state || !sealedTx) return c.json({ error: "invalid_request" }, 400);

  const tx = await hmacUnseal(sealedTx, c.env.COOKIE_SECRET);
  if (!tx) return c.json({ error: "bad_state" }, 403);
  const [txState, verifier] = tx.split(".");
  if (txState !== state) return c.json({ error: "state_mismatch" }, 403);

  const token = await exchangeCode({ env: c.env, code, redirectUri: callbackUrl(c.req.url), verifier });
  if (!token) return c.json({ error: "exchange_failed" }, 401);

  const ghUser = await getUser(token);
  if (!ghUser) return c.json({ error: "identity_failed" }, 401);
  if (!(await isActiveOrgMember(token))) return c.redirect("/?denied=1", 302);

  await run(c.env.DB,
    `INSERT INTO users (github_login, name, avatar_url, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url`,
    ghUser.login, ghUser.name, ghUser.avatar_url, nowIso());

  const { id } = await createSession(c.env.DB, ghUser.login);
  await setSessionCookie(c, id, c.env.COOKIE_SECRET);
  return c.redirect("/", 302);
});

// GATED (by sessionGate in src/routes.ts): return the principal's profile.
authApp.get("/me", async (c) => {
  const login = c.get("principal").login;
  const row = await first<{ name: string | null; avatar_url: string | null }>(c.env.DB, `SELECT name, avatar_url FROM users WHERE github_login = ?`, login);
  return c.json({ login, name: row?.name ?? null, avatar_url: row?.avatar_url ?? null, org: SAPLING_ORG, admin: isAdmin(c.env, login) });
});

// GATED (by sessionGate in src/routes.ts): revoke this session.
authApp.post("/logout", async (c) => {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (id) await deleteSession(c.env.DB, id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// GATED: mint a personal MCP bearer token; the raw token is shown ONCE.
authApp.post("/mcp-token", async (c) => {
  const { raw } = await mintToken(c.env.DB, c.get("principal").login);
  return c.json({ token: raw });
});
