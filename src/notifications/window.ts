// Run windows (canopy-email.md §4). All calendar math is in the org timezone
// (notification_settings.timezone): the daily id is the local send date, the
// weekly id the ISO week of the local send date.
import type { RunCadence, Window } from "@shared/notifications";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface LocalDate { year: number; month: number; day: number; hour: number; weekday: number; } // weekday: 0=Sun..6=Sat

export function localDate(d: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, weekday };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dailyId(d: LocalDate): string {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** ISO-8601 week id (`YYYY-Www`) of a calendar date. */
export function isoWeekId(d: LocalDate): string {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const dayNum = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

/**
 * The window a run at `now` covers. Daily: the previous 24h, except a Monday
 * run reaches back to the Friday run (72h) so the weekend is never dropped.
 * Weekly: the previous 7 days.
 */
export function computeWindow(cadence: RunCadence, now: Date, timeZone: string): Window {
  const local = localDate(now, timeZone);
  if (cadence === "weekly") {
    return { cadence, start: new Date(now.getTime() - 7 * DAY), end: now, id: isoWeekId(local) };
  }
  const span = local.weekday === 1 ? 3 * DAY : DAY;
  return { cadence, start: new Date(now.getTime() - span), end: now, id: dailyId(local) };
}
