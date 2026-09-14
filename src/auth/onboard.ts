import type { DB } from "../db";
import type { IdentityProvider } from "@shared/rows";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { findIdentity, findPersonByEmail, linkIdentity, recordSignIn, isValidHandle } from "./persons";
import { findLiveInvite } from "./invites";

export interface ProviderProfile { provider: IdentityProvider; subject: string; label: string; email: string | null; name: string | null; avatar_url: string | null }
export interface OnboardPayload extends ProviderProfile { suggested_handle: string; invite_email: string | null }
export const ONBOARD_COOKIE = "onboard";
export const ONBOARD_TTL_S = 600;

export type ForkResult = { kind: "session"; handle: string } | { kind: "onboard"; payload: OnboardPayload } | { kind: "denied" };

/** github → login lowercased; otherwise the email local part squeezed into the handle alphabet. */
export function suggestHandle(p: ProviderProfile): string {
  const raw = p.provider === "github" ? p.subject : (p.email ?? p.label).split("@")[0];
  let h = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  if (!/^[a-z]/.test(h)) h = `p-${h}`.slice(0, 24);
  return isValidHandle(h) ? h : "me-" + Math.random().toString(36).slice(2, 8);
}

export function sealOnboard(payload: OnboardPayload, secret: string): Promise<string> {
  return hmacSeal(b64uEncode(JSON.stringify(payload)), `onboard:${secret}`);
}
export async function openOnboard(sealed: string, secret: string): Promise<OnboardPayload | null> {
  const v = await hmacUnseal(sealed, `onboard:${secret}`);
  if (!v) return null;
  try { return JSON.parse(b64uDecode(v)) as OnboardPayload; } catch { return null; }
}

/**
 * The fork both callbacks run after their provider gate passed.
 * 1 known identity → session. 2 verified email matches a person → link + session.
 * 3 live invite (Google) / org member (GitHub) → onboard. 4 otherwise → denied.
 */
export async function completeSignIn(db: DB, p: ProviderProfile): Promise<ForkResult> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) {
    await recordSignIn(db, known.person, { name: p.name, avatar_url: p.avatar_url, email: p.email });
    return { kind: "session", handle: known.person };
  }
  if (p.email) {
    const byEmail = await findPersonByEmail(db, p.email);
    if (byEmail) {
      await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: byEmail.handle, linkedBy: byEmail.handle });
      await recordSignIn(db, byEmail.handle, { name: p.name, avatar_url: p.avatar_url, email: p.email });
      return { kind: "session", handle: byEmail.handle };
    }
  }
  const invite = p.email ? await findLiveInvite(db, p.email) : null;
  if (p.provider === "github" || invite) {
    return { kind: "onboard", payload: { ...p, name: p.name ?? invite?.name ?? null, suggested_handle: suggestHandle(p), invite_email: invite?.email ?? null } };
  }
  return { kind: "denied" };
}

/** Link mode: attach the identity to the signed-in person unless someone else already owns it. */
export async function linkSignIn(db: DB, handle: string, p: ProviderProfile): Promise<"linked" | "belongs_to_other"> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) return known.person.toLowerCase() === handle.toLowerCase() ? "linked" : "belongs_to_other";
  await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: handle, linkedBy: handle });
  return "linked";
}
