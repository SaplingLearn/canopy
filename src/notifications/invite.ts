// The invite email: one transactional message per invite (create or resend),
// through the same delivery gate as the digests. Not a NotificationKind — no
// cadence, prefs, or window. The outcome lands on the invite row.
import type { Env } from "../env";
import { type DB, nowIso } from "../db";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";
import { getPerson } from "../auth/persons";
import { recordInviteEmail } from "../auth/invites";

export function inviteSignInUrl(origin: string, email: string): string {
  return `${origin}/auth/google/login?login_hint=${encodeURIComponent(email)}`;
}

export function renderInviteEmail(o: { inviteeName: string | null; inviterName: string; email: string; signInUrl: string; host: string }): { subject: string; html: string; text: string } {
  const subject = `${o.inviterName} invited you to Canopy`;
  const hi = o.inviteeName ? `Hi ${escapeHtml(o.inviteeName)},` : "Hi,";
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    `<tr><td style="padding:28px 28px 8px 28px;${EMAIL_FONT.sans}font-size:15px;font-weight:600;color:${C.fg};">Canopy</td></tr>` +
    `<tr><td style="padding:8px 28px 0 28px;"><div style="${p}color:${C.fg};">${hi}</div>` +
    `<div style="${p}">${escapeHtml(o.inviterName)} invited you to Canopy, the Sapling team's shared workspace. Sign in with this Google address to pick your handle and get started.</div>` +
    `<div style="padding:6px 0 20px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in with Google</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This invite is for <span style="${EMAIL_FONT.mono}">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Canopy &middot; ${escapeHtml(o.host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    o.inviteeName ? `Hi ${o.inviteeName},` : "Hi,", "",
    `${o.inviterName} invited you to Canopy, the Sapling team's shared workspace.`,
    "Sign in with this Google address to pick your handle and get started:", "",
    `  ${o.signInUrl}`, "",
    `This invite is for ${o.email}. If you weren't expecting it, you can ignore this email.`,
    `Sent by Canopy — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

export async function sendInvite(env: Env, db: DB, o: { email: string; inviteeName: string | null; inviterHandle: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }> {
  const inviter = await getPerson(db, o.inviterHandle);
  const settings = await loadSettings(db);
  const msg = renderInviteEmail({
    inviteeName: o.inviteeName, inviterName: inviter?.name ?? o.inviterHandle, email: o.email,
    signInUrl: inviteSignInUrl(o.origin, o.email), host: o.origin.replace(/^https?:\/\//, "") || "canopy",
  });
  let result: { status: "sent" | "failed"; id: string | null; error: string | null };
  try {
    const delivery = deliveryFor(env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `invite:${o.email}:${nowIso()}`, userId: o.email, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    result = { status: "sent", id: r.id, error: null };
  } catch (e) {
    result = { status: "failed", id: null, error: e instanceof Error ? e.message : String(e) };
  }
  await recordInviteEmail(db, o.email, { id: result.id, error: result.error });
  return result;
}
