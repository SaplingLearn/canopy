// The signed one-click unsubscribe path (canopy-email.md §7) — the single
// exception to the no-token rule, because the only action the token can
// perform is setting email_unsubscribed = 1 for the login it names. It is
// HMAC-SHA256 over the login with COOKIE_SECRET (hmacSeal: `login.sig`), never
// expires by design, and carries nothing else.
import { hmacSeal, hmacUnseal } from "../auth/crypto";

const NS = "unsub"; // domain-separates the signature from session cookies

export async function unsubscribeToken(login: string, secret: string): Promise<string> {
  return hmacSeal(login, `${NS}:${secret}`);
}

/** The login the token was issued for, or null if malformed/tampered/foreign. */
export async function verifyUnsubscribeToken(token: string, secret: string): Promise<string | null> {
  return hmacUnseal(token, `${NS}:${secret}`);
}

export async function unsubscribeUrl(origin: string, login: string, secret: string): Promise<string> {
  return `${origin}/u/${await unsubscribeToken(login, secret)}`;
}
