// One message per user per run, laid out per the Canopy Email design
// (email/digest-daily.html, digest.txt): a 600px card, a green-ruled header
// with the subject, one block per section (heading, subline, body, "Open X →"),
// and a footer naming the recipient with the unsubscribe link. Plain-text
// alternative always included.
import type { Section, Window } from "@shared/notifications";
import { escapeHtml } from "./html";
import { localDate } from "./window";

export interface AssembledMessage {
  subject: string;
  html: string;
  text: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 24 * 60 * 60 * 1000;

const SANS = "font-family:Helvetica,Arial,sans-serif;";
const MONO = "font-family:'Courier New',Courier,monospace;";
export const EMAIL_STYLE = {
  label: `${MONO}font-size:10px;letter-spacing:1px;color:#8a8a8a;`,
  mono: `${MONO}font-size:12px;color:#6b6b6b;vertical-align:top;padding:4px 0;`,
  body: `${SANS}font-size:13px;line-height:1.5;color:#0a0a0a;padding:4px 0;`,
  muted: `${SANS}font-size:12px;line-height:1.5;color:#8a8a8a;`,
  table: `role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
};

function dayLabel(d: Date, timeZone: string): { month: string; day: number } {
  const l = localDate(d, timeZone);
  return { month: MONTHS[l.month - 1], day: l.day };
}

/** `Canopy daily, Sep 11` / `Canopy weekly, Sep 7 to 11` (start to the last weekday before the send). */
export function subjectFor(window: Window, timeZone: string): string {
  return `Canopy ${window.cadence}, ${dateRange(window, timeZone)}`;
}

function dateRange(window: Window, timeZone: string): string {
  if (window.cadence === "daily") {
    const d = dayLabel(window.end, timeZone);
    return `${d.month} ${d.day}`;
  }
  const from = dayLabel(window.start, timeZone);
  let last = new Date(window.end.getTime() - DAY);
  while ([0, 6].includes(localDate(last, timeZone).weekday)) last = new Date(last.getTime() - DAY);
  const to = dayLabel(last, timeZone);
  return from.month === to.month ? `${from.month} ${from.day} to ${to.day}` : `${from.month} ${from.day} to ${to.month} ${to.day}`;
}

export function assembleMessage(opts: {
  sections: Section[];
  window: Window;
  timeZone: string;
  origin: string;
  login: string;
  unsubscribeUrl: string;
}): AssembledMessage {
  const { sections, window, timeZone, origin, login, unsubscribeUrl } = opts;
  const subject = subjectFor(window, timeZone);
  const range = dateRange(window, timeZone);
  const link = (s: Section) => `${origin}${s.deepLink}`;
  const label = (s: Section) => s.linkLabel ?? s.heading;
  const host = origin.replace(/^https?:\/\//, "") || "canopy";
  const preheader = sections.map((s) => s.summary).filter(Boolean).join(", ");

  const blocks = sections.map(
    (s, i) =>
      `<tr><td style="padding:${i === 0 ? "26px 32px" : "24px 32px 26px 32px"};${i === 0 ? "" : "border-top:1px solid #e6e6e6;"}">` +
      `<div style="${SANS}font-size:15px;font-weight:bold;color:#0a0a0a;">${escapeHtml(s.heading)}</div>` +
      (s.summary ? `<div style="${SANS}font-size:13px;color:#6b6b6b;padding-top:3px;">${escapeHtml(s.summary)}</div>` : "") +
      s.html +
      `<div style="padding-top:16px;"><a href="${escapeHtml(link(s))}" style="${SANS}font-size:13px;font-weight:bold;color:#00A859;text-decoration:none;">Open ${escapeHtml(label(s))} &rarr;</a></div>` +
      `</td></tr>`
  );

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f2f2f2;">` +
    (preheader ? `<div style="display:none;max-height:0px;overflow:hidden;">${escapeHtml(preheader)}.</div>` : "") +
    `<table ${EMAIL_STYLE.table} style="background-color:#f2f2f2;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #e2e2e2;">` +
    `<tr><td style="padding:24px 32px 20px 32px;border-bottom:2px solid #00A859;${SANS}font-size:19px;line-height:1.3;color:#0a0a0a;"><strong>Canopy</strong> ${window.cadence}, ${escapeHtml(range)}</td></tr>` +
    blocks.join("") +
    `<tr><td style="padding:18px 32px 22px 32px;border-top:1px solid #e6e6e6;${SANS}font-size:11px;line-height:1.7;color:#8a8a8a;">` +
    `You're getting the ${window.cadence} Canopy digest for ${escapeHtml(login)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a><br>` +
    `Sent by Canopy &middot; ${escapeHtml(host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const title = `CANOPY ${window.cadence.toUpperCase()} — ${range.toUpperCase()}`;
  const text = [
    title,
    "=".repeat(title.length),
    "",
    ...sections.flatMap((s) => [
      s.heading.toUpperCase(),
      ...(s.summary ? [s.summary] : []),
      "",
      s.text,
      "",
      `  -> ${label(s)}: ${link(s)}`,
      "",
    ]),
    "-".repeat(title.length),
    `You're getting the ${window.cadence} Canopy digest for ${login}.`,
    `Unsubscribe: ${unsubscribeUrl}`,
    `Sent by Canopy — ${host}`,
    "",
  ].join("\n");

  return { subject, html, text };
}
