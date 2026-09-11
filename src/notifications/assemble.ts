// One message per user per run: subject per §7, an HTML body with every
// rendered section, and a plain-text alternative (always included).
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

function dayLabel(d: Date, timeZone: string): { month: string; day: number } {
  const l = localDate(d, timeZone);
  return { month: MONTHS[l.month - 1], day: l.day };
}

/** `Canopy daily, Sep 11` / `Canopy weekly, Sep 7 to 11` (start to the last weekday before the send). */
export function subjectFor(window: Window, timeZone: string): string {
  if (window.cadence === "daily") {
    const d = dayLabel(window.end, timeZone);
    return `Canopy daily, ${d.month} ${d.day}`;
  }
  const from = dayLabel(window.start, timeZone);
  let last = new Date(window.end.getTime() - DAY);
  while ([0, 6].includes(localDate(last, timeZone).weekday)) last = new Date(last.getTime() - DAY);
  const to = dayLabel(last, timeZone);
  const range = from.month === to.month ? `${from.month} ${from.day} to ${to.day}` : `${from.month} ${from.day} to ${to.month} ${to.day}`;
  return `Canopy weekly, ${range}`;
}

export function assembleMessage(opts: { sections: Section[]; window: Window; timeZone: string; origin: string }): AssembledMessage {
  const { sections, window, timeZone, origin } = opts;
  const subject = subjectFor(window, timeZone);
  const link = (s: Section) => `${origin}${s.deepLink}`;

  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px">` +
    `<h1 style="font-size:20px">${escapeHtml(subject)}</h1>` +
    sections
      .map(
        (s) =>
          `<section><h2 style="font-size:16px"><a href="${escapeHtml(link(s))}">${escapeHtml(s.heading)}</a></h2>${s.html}` +
          `<p><a href="${escapeHtml(link(s))}">Open ${escapeHtml(s.heading)} in Canopy</a></p></section>`
      )
      .join("<hr>") +
    `</body></html>`;

  const text = [subject, "", ...sections.map((s) => `## ${s.heading}\n${s.text}\n\nOpen in Canopy: ${link(s)}`)].join("\n\n");

  return { subject, html, text };
}
