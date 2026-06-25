import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal, encryptSecret } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, isActiveOrgMember } from "./github";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken } from "./tokens";
import { run, nowIso } from "../db";

const OAUTH_TX_COOKIE = "oauth_tx";

export const authApp = new Hono<AppEnv>();

// PUBLIC: start the OAuth dance.
authApp.get("/login", async (c) => {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const origin = new URL(c.req.url).origin;
  return c.redirect(
    buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: `${origin}/auth/callback`, state, challenge }),
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

  const origin = new URL(c.req.url).origin;
  const token = await exchangeCode({ env: c.env, code, redirectUri: `${origin}/auth/callback`, verifier });
  if (!token) return c.json({ error: "exchange_failed" }, 401);

  const ghUser = await getUser(token);
  if (!ghUser) return c.json({ error: "identity_failed" }, 401);
  if (!(await isActiveOrgMember(token))) return c.json({ error: "forbidden" }, 403);

  const sealedToken = await encryptSecret(token, c.env.COOKIE_SECRET);
  await run(c.env.DB,
    `INSERT INTO users (github_login, name, github_token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET name = excluded.name, github_token = excluded.github_token`,
    ghUser.login, ghUser.name, sealedToken, nowIso());

  const { id } = await createSession(c.env.DB, ghUser.login);
  await setSessionCookie(c, id, c.env.COOKIE_SECRET);
  return c.redirect("/", 302);
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
