import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { PERSON_COLORS } from "@shared/rows";
import type { AppEnv } from "./principal";
import { isAdmin, resolveSessionPrincipal } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, getPrimaryEmail, isActiveOrgMember, SAPLING_ORG } from "./github";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken } from "./tokens";
import { getPerson, listIdentities, handleAvailable, createPerson, HandleTakenError, linkIdentity, unlinkIdentity, updateProfile } from "./persons";
import { completeSignIn, linkSignIn, sealOnboard, openOnboard, ONBOARD_COOKIE, ONBOARD_TTL_S, type ProviderProfile, type ForkResult } from "./onboard";
import { findLiveInvite, acceptInvite } from "./invites";

const OAUTH_TX_COOKIE = "oauth_tx";
export interface AuthDeps { fetchImpl?: typeof fetch; now?: () => number }

/**
 * The OAuth callback URL for this request. GitHub/Google require an https callback for
 * public hosts (http is only valid for localhost), so we force https for everything
 * except local dev. Without this, a request that reached the Worker over http (e.g.
 * before an edge http->https upgrade, or a bare-hostname browser navigation) would emit
 * an http redirect_uri that the provider rejects. The same value is used for the
 * authorize redirect and the token exchange, so they always match.
 */
export function callbackUrl(reqUrl: string, provider: "github" | "google" = "github"): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme = isLocal ? u.protocol.replace(/:$/, "") : "https";
  return `${scheme}://${u.host}${provider === "google" ? "/auth/google/callback" : "/auth/callback"}`;
}

type TxMode = "signin" | "link";
async function beginTx(c: Context<AppEnv>, mode: TxMode): Promise<{ state: string; challenge: string }> {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}.${mode}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return { state, challenge };
}

export function buildAuthApp(deps: AuthDeps = {}): Hono<AppEnv> {
  const authApp = new Hono<AppEnv>();
  const f = deps.fetchImpl;

  /** Common tail after a provider profile is in hand. */
  async function finish(c: Context<AppEnv>, mode: TxMode, profile: ProviderProfile, denied: string) {
    if (mode === "link") {
      const me = await resolveSessionPrincipal(c);
      if (!me) return c.json({ error: "unauthorized" }, 403);
      const r = await linkSignIn(c.env.DB, me.handle, profile);
      return c.redirect(r === "linked" ? "/#settings" : "/?link=conflict#settings", 302);
    }
    const r: ForkResult = await completeSignIn(c.env.DB, profile);
    if (r.kind === "denied") return c.redirect(denied, 302);
    if (r.kind === "onboard") {
      setCookie(c, ONBOARD_COOKIE, await sealOnboard(r.payload, c.env.COOKIE_SECRET), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: ONBOARD_TTL_S });
      return c.redirect("/#onboard", 302);
    }
    const { id } = await createSession(c.env.DB, r.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    return c.redirect("/", 302);
  }

  async function openTx(c: Context<AppEnv>) {
    const code = c.req.query("code"); const state = c.req.query("state");
    const sealedTx = getCookie(c, OAUTH_TX_COOKIE);
    deleteCookie(c, OAUTH_TX_COOKIE, { path: "/" });
    if (!code || !state || !sealedTx) return { error: c.json({ error: "invalid_request" }, 400) };
    const tx = await hmacUnseal(sealedTx, c.env.COOKIE_SECRET);
    if (!tx) return { error: c.json({ error: "bad_state" }, 403) };
    const [txState, verifier, mode] = tx.split(".");
    if (txState !== state) return { error: c.json({ error: "state_mismatch" }, 403) };
    return { code, verifier, mode: (mode === "link" ? "link" : "signin") as TxMode };
  }

  // ── GitHub ──
  authApp.get("/login", async (c) => {
    const mode: TxMode = c.req.query("link") === "1" && (await resolveSessionPrincipal(c)) ? "link" : "signin";
    const { state, challenge } = await beginTx(c, mode);
    return c.redirect(buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: callbackUrl(c.req.url), state, challenge }), 302);
  });
  authApp.get("/callback", async (c) => {
    const tx = await openTx(c);
    if ("error" in tx) return tx.error;
    const token = await exchangeCode({ env: c.env, code: tx.code, redirectUri: callbackUrl(c.req.url), verifier: tx.verifier, fetchImpl: f });
    if (!token) return c.json({ error: "exchange_failed" }, 401);
    const gh = await getUser(token, f);
    if (!gh) return c.json({ error: "identity_failed" }, 401);
    if (!(await isActiveOrgMember(token, f))) return c.redirect("/?denied=1", 302);
    const profile: ProviderProfile = { provider: "github", subject: gh.login, label: gh.login, email: await getPrimaryEmail(token, f), name: gh.name, avatar_url: gh.avatar_url };
    return finish(c, tx.mode, profile, "/?denied=1");
  });

  // ── Google (Task 7 fills these two in) ──

  // ── Onboarding (gated by the onboard cookie, not the session) ──
  async function onboardPayload(c: Context<AppEnv>) {
    const sealed = getCookie(c, ONBOARD_COOKIE);
    return sealed ? openOnboard(sealed, c.env.COOKIE_SECRET) : null;
  }
  authApp.get("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    return c.json({ provider: p.provider, label: p.label, email: p.email, name: p.name, avatar_url: p.avatar_url, suggested_handle: p.suggested_handle });
  });
  authApp.get("/handle-check", async (c) => {
    if (!(await onboardPayload(c))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await handleAvailable(c.env.DB, (c.req.query("handle") ?? "").trim()));
  });
  const OnboardWrite = z.object({ handle: z.string().trim(), name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS) });
  authApp.post("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    const parsed = OnboardWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    const avail = await handleAvailable(c.env.DB, parsed.data.handle);
    if (!avail.available) return c.json({ error: avail.reason === "taken" ? "handle_taken" : `handle_${avail.reason}` }, avail.reason === "taken" ? 409 : 400);
    if (p.invite_email && !(await findLiveInvite(c.env.DB, p.invite_email))) return c.json({ error: "invite_revoked" }, 403);
    try {
      await createPerson(c.env.DB, { handle: parsed.data.handle, name: parsed.data.name ?? p.name, color: parsed.data.color, avatar_url: p.avatar_url, email: p.email });
    } catch (e) {
      if (e instanceof HandleTakenError) return c.json({ error: "handle_taken" }, 409);
      throw e;
    }
    await linkIdentity(c.env.DB, { provider: p.provider, subject: p.subject, label: p.label, person: parsed.data.handle, linkedBy: parsed.data.handle });
    if (p.invite_email) await acceptInvite(c.env.DB, p.invite_email, parsed.data.handle);
    deleteCookie(c, ONBOARD_COOKIE, { path: "/" });
    const { id } = await createSession(c.env.DB, parsed.data.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    return c.json({ ok: true, handle: parsed.data.handle });
  });

  // ── Session-gated ──
  authApp.get("/me", async (c) => {
    const handle = c.get("principal").handle;
    const row = await getPerson(c.env.DB, handle);
    const identities = (await listIdentities(c.env.DB, handle)).map((i) => ({ provider: i.provider, label: i.label, linked_at: i.linked_at }));
    return c.json({ handle, name: row?.name ?? null, avatar_url: row?.avatar_url ?? null, color: row?.color ?? "stone", identities, org: SAPLING_ORG, admin: isAdmin(c.env, handle) });
  });
  const ProfileWrite = z.object({ name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS).optional() });
  authApp.put("/me", async (c) => {
    const parsed = ProfileWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    const row = await updateProfile(c.env.DB, c.get("principal").handle, parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, name: row.name, color: row.color });
  });
  authApp.post("/identities/:provider/unlink", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.json({ error: "unknown provider" }, 400);
    const r = await unlinkIdentity(c.env.DB, c.get("principal").handle, provider);
    if (r === "last_identity") return c.json({ error: "last_identity" }, 409);
    if (r === "not_found") return c.json({ error: "not linked" }, 404);
    return c.json({ ok: true });
  });
  authApp.post("/logout", async (c) => {
    const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
    if (id) await deleteSession(c.env.DB, id);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  authApp.post("/mcp-token", async (c) => {
    const { raw } = await mintToken(c.env.DB, c.get("principal").handle);
    return c.json({ token: raw });
  });
  return authApp;
}

export const authApp = buildAuthApp();
