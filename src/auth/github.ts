import type { Env } from "../env";

export const SAPLING_ORG = "SaplingLearn";
const USER_AGENT = "sapling-context";
const GH_API = "application/vnd.github+json";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", "read:org read:user");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Exchange an authorization code (+ PKCE verifier) for an access token; null on failure. */
export async function exchangeCode(opts: {
  env: Env;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: opts.env.GITHUB_CLIENT_ID,
      client_secret: opts.env.GITHUB_CLIENT_SECRET,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/** The authenticated user's login + name; null on failure. */
export async function getUser(token: string): Promise<{ login: string; name: string | null } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { login?: string; name?: string | null };
  return data.login ? { login: data.login, name: data.name ?? null } : null;
}

/** True only if the token's owner is an ACTIVE member of SAPLING_ORG. */
export async function isActiveOrgMember(token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/user/memberships/orgs/${SAPLING_ORG}`, {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return false; // 404 => not a member
  const data = (await res.json()) as { state?: string };
  return data.state === "active"; // a pending invite does not count
}
