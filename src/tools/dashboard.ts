import type { RoadmapPhase, AssignedIssue, DashboardData, Focus } from "@shared/dashboard";
import type { DB } from "../db";
import { get_focus, get_feed } from "./reads";
import { loginToPerson } from "../people";

const GH_API = "application/vnd.github+json";
const USER_AGENT = "canopy";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A "## " heading is a time-phased sprint section if it starts with "Now", carries a
 *  parenthetical with a year, or names a month. Excludes meta sections (Team table, etc.). */
function isTimePhased(heading: string): boolean {
  if (/^Now\b/i.test(heading)) return true;
  if (/\([^)]*\d{4}[^)]*\)/.test(heading)) return true;
  return MONTHS.some((m) => new RegExp(`(^|\\s)${m}\\b`, "i").test(heading));
}

/** Split "Weeks 3–4 (~2026-06-22 → 2026-07-05)" into title + window (parenthetical, no parens). */
function splitTitleWindow(heading: string): { title: string; window: string | null } {
  const m = heading.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { title: m[1].trim(), window: m[2].trim() };
  return { title: heading.trim(), window: null };
}

/** A phase's start time in ms. A range "A → B" uses A; an end-only "through B" or a
 *  date-less heading is treated as -Infinity (early); a month-only heading uses the 1st
 *  of that month, inferring the year from `today`. */
function phaseStartMs(title: string, window: string | null, today: string): number {
  const w = window ?? "";
  const dates = w.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const hasArrow = /→|->/.test(w);
  if (hasArrow && dates.length >= 1) return Date.parse(dates[0] + "T00:00:00Z");
  if (!hasArrow && dates.length === 1 && !/through/i.test(w)) return Date.parse(dates[0] + "T00:00:00Z");
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`(^|\\s)${m}\\b`, "i").test(title));
  if (monthIdx >= 0) {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7)); // 1-12
    const year = monthIdx + 1 < tm ? ty + 1 : ty;
    return Date.parse(`${year}-${String(monthIdx + 1).padStart(2, "0")}-01T00:00:00Z`);
  }
  return -Infinity;
}

export interface ParsedRoadmap {
  role: string | null;
  owns: string | null;
  workingNow: RoadmapPhase | null;
  comingUp: RoadmapPhase[];
}

/** Parse a person's role/owns + their now/upcoming bullets out of ROADMAP.md. Pure. */
export function parseRoadmapForPerson(markdown: string, person: string, today: string): ParsedRoadmap {
  const lines = markdown.split(/\r?\n/);

  // role / owns: the Team & Responsibilities table row has the person bolded in column 1.
  let role: string | null = null;
  let owns: string | null = null;
  const teamRe = new RegExp(`^\\|\\s*\\*\\*${escapeRegExp(person)}\\*\\*\\s*\\|`);
  const teamRow = lines.find((l) => teamRe.test(l));
  if (teamRow) {
    const cells = teamRow.split("|").map((c) => c.trim()); // ["", "**Andres**", "Fullstack", "Owns…", ""]
    role = cells[2] || null;
    owns = cells[3] || null;
  }

  // index every "## " heading, then walk each time-phased section.
  const headingIdx: number[] = [];
  lines.forEach((l, i) => { if (/^##\s+/.test(l)) headingIdx.push(i); });

  interface RawPhase { title: string; window: string | null; start: number; bullet: string; issueRefs: number[]; }
  const phases: RawPhase[] = [];
  const bulletRe = new RegExp(`^-\\s*\\*\\*${escapeRegExp(person)}\\*\\*`);
  const stripRe = new RegExp(`^[-*]\\s*\\*\\*${escapeRegExp(person)}\\*\\*\\s*[—–-]?\\s*`);

  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h];
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
    const heading = lines[start].replace(/^##\s+/, "").trim();
    if (!isTimePhased(heading)) continue;
    const { title, window } = splitTitleWindow(heading);

    let bullet = "";
    for (let i = start + 1; i < end; i++) {
      if (bulletRe.test(lines[i])) {
        const buf = [lines[i]];
        for (let j = i + 1; j < end; j++) {
          const nxt = lines[j];
          if (/^-\s/.test(nxt) || /^#/.test(nxt) || nxt.trim() === "") break; // stop at next bullet/heading/blank
          buf.push(nxt);
        }
        bullet = buf.join(" ").replace(/\s+/g, " ").trim().replace(stripRe, "");
        break;
      }
    }
    const issueRefs = [...new Set([...bullet.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
    phases.push({ title, window, start: phaseStartMs(title, window, today), bullet, issueRefs });
  }

  // current phase = the last whose start ≤ today; if no real dates anywhere, fall back to first.
  const todayMs = Date.parse(today);
  const hasRealDate = phases.some((p) => p.start !== -Infinity);
  let currentIndex = 0;
  if (hasRealDate) {
    let found = -1;
    phases.forEach((p, i) => { if (p.start <= todayMs) found = i; });
    currentIndex = found >= 0 ? found : 0;
  }

  const toPhase = (p: RawPhase): RoadmapPhase => ({ title: p.title, window: p.window, bullet: p.bullet, issueRefs: p.issueRefs });
  // from the current phase onward, keep only phases where this person actually has a bullet.
  const fromCurrent = phases.slice(currentIndex).filter((p) => p.bullet.length > 0);
  const workingNow = fromCurrent[0] ? toPhase(fromCurrent[0]) : null;
  const comingUp = fromCurrent.slice(1).map(toPhase);

  return { role, owns, workingNow, comingUp };
}

function priorityOf(title: string): "P0" | "P1" | "P2" | "P3" | null {
  const m = title.match(/^\s*\[(P[0-3])\]/);
  return m ? (m[1] as "P0" | "P1" | "P2" | "P3") : null;
}
function stripPriority(title: string): string {
  return title.replace(/^\s*\[P[0-3]\]\s*/, "").trim();
}

/** Open issues assigned to `login` in `repo`, fetched live. PRs are filtered out (the
 *  issues endpoint returns both). Never throws — returns `{ issues: [], ok: false }` on
 *  any non-OK/parse failure so callers can distinguish "no issues" from "token failed". */
export async function listAssignedIssues(opts: {
  token: string;
  repo: string;
  login: string;
  fetchImpl?: typeof fetch;
}): Promise<{ issues: AssignedIssue[]; ok: boolean }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, accept: GH_API, "user-agent": USER_AGENT };
  const url = `https://api.github.com/repos/${opts.repo}/issues?assignee=${encodeURIComponent(opts.login)}&state=open&per_page=50`;
  try {
    const res = await doFetch(url, { headers });
    if (!res.ok) return { issues: [], ok: false };
    const data = (await res.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      updated_at: string;
      pull_request?: unknown;
      labels?: Array<{ name?: string } | string>;
    }>;
    return {
      issues: data
        .filter((it) => !it.pull_request)
        .map((it) => ({
          number: it.number,
          title: stripPriority(it.title),
          priority: priorityOf(it.title),
          labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
          url: it.html_url,
          updatedAt: it.updated_at,
        })),
      ok: true,
    };
  } catch {
    return { issues: [], ok: false };
  }
}

/** Fetch ROADMAP.md raw from `repo`. Never throws — returns null on any failure. */
export async function fetchRoadmapMarkdown(opts: {
  token: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${opts.repo}/contents/ROADMAP.md`, {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github.raw", "user-agent": USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Assemble the personal dashboard. D1 data (focus, feed) is always returned; the
 *  GitHub-derived roadmap/issues are returned when the token works, else degraded. */
export async function getMyDashboard(opts: {
  db: DB;
  login: string;
  token: string | null;
  repo: string;
  today: string;
  fetchImpl?: typeof fetch;
}): Promise<DashboardData> {
  const { db, login, token, repo, today, fetchImpl } = opts;

  const focusRow = await get_focus(db, login);
  const focus: Focus | null = focusRow
    ? { workingOn: focusRow.working_on, nextUp: focusRow.next_up, updatedAt: focusRow.updated_at }
    : null;
  const feed = await get_feed(db, { author: login, limit: 8 });
  const person = loginToPerson(login);

  let role: string | null = null;
  let owns: string | null = null;
  let workingNow: RoadmapPhase | null = null;
  let comingUp: RoadmapPhase[] = [];
  let assignedIssues: AssignedIssue[] = [];
  let degraded = false;

  if (!token) {
    degraded = true;
  } else {
    const [md, issuesRes] = await Promise.all([
      person ? fetchRoadmapMarkdown({ token, repo, fetchImpl }) : Promise.resolve(null),
      listAssignedIssues({ token, repo, login, fetchImpl }),
    ]);
    assignedIssues = issuesRes.issues;
    if (!issuesRes.ok) degraded = true;        // the token actually failed for GitHub
    if (person && md) {
      const parsed = parseRoadmapForPerson(md, person, today);
      role = parsed.role;
      owns = parsed.owns;
      workingNow = parsed.workingNow;
      comingUp = parsed.comingUp;
    }
  }

  return { person, role, owns, focus, workingNow, comingUp, assignedIssues, feed, degraded };
}
