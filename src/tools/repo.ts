import type {
  RepoActivity, RepoBars, RepoCodeStat, RepoContributor, RepoDashboard, RepoLabels,
  RepoPerson, RepoPr, RepoSection, RepoSprint, RepoStat, RepoTone,
} from "@shared/repo";
import type { PersonColor } from "@shared/rows";
import { type DB, all, first, nowIso } from "../db";
import { list_sprints } from "./sprints";
import { hasCaptured, prStatesAsOf, recentPrRows, commitsByDay, pushRowsSince, recordingSince } from "../repo/reads";
import { getSnapshot } from "../repo/store";
import type { RepoEventRow } from "../repo/types";

// The Repo dashboard: a D1-ONLY read projection, in the same class as My Work —
// no live GitHub, no per-user token, nothing written. It reads what the webhook
// and the backfill already captured (`events`: merged/closed PRs + issue
// snapshots), the ticket queue and the sprints.
//
// Everything Canopy has NO capture path for — deploys, CI runs, branches,
// commits, coverage, bundle size, usage, Cloudflare analytics, health checks,
// TODO counts — is returned as `not_connected`, never guessed. Adding a capture
// path later means flipping ONE section here from `not_connected` to `ok`; the
// screen already renders every section's live shape.

const DAY = 86_400_000;
const PR_LIMIT = 8;
const ACTIVITY_LIMIT = 20;
const CONTRIBUTOR_LIMIT = 8;
const LABEL_LIMIT = 6;
const BAR_DAYS = 14; // = the two-week PR window below

/** Event time: the payload's own clock, else when Canopy recorded it. */
const AT = `COALESCE(occurred_at, recorded_at)`;

const ok = <T>(data: T): RepoSection<T> => ({ status: "ok", data });
const EMPTY = { status: "empty" } as const;
const NOT_CONNECTED = { status: "not_connected" } as const;

/** The sections no capture path feeds yet. One object so the list is auditable. */
const UNCAPTURED = {
  environments: NOT_CONNECTED, drift: NOT_CONNECTED, health: NOT_CONNECTED,
  branches: NOT_CONNECTED,
  deploys: NOT_CONNECTED, ciFailures: NOT_CONNECTED, coverage: NOT_CONNECTED, bundle: NOT_CONNECTED,
  usage: NOT_CONNECTED, cloudflare: NOT_CONNECTED, hosting: NOT_CONNECTED,
  todos: NOT_CONNECTED,
} as const;

export function emptyRepoDashboard(repo: string, degraded: boolean): RepoDashboard {
  return {
    repo, generatedAt: nowIso(), degraded, ...UNCAPTURED,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY,
    sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
  };
}

// ── people ───────────────────────────────────────────────────────────────────
type PersonMap = Map<string, RepoPerson>;

/** Every mapped GitHub login → its person, in ONE query (logins are case-insensitive). */
async function personsByLogin(db: DB): Promise<PersonMap> {
  const rows = await all<{ subject: string; handle: string; name: string | null; color: PersonColor }>(
    db,
    `SELECT i.subject, p.handle, p.name, p.color FROM identities i
       JOIN persons p ON p.handle = i.person WHERE i.provider = 'github'`
  );
  const out: PersonMap = new Map();
  for (const r of rows) out.set(r.subject.toLowerCase(), { login: r.subject, handle: r.handle, name: r.name, color: r.color });
  return out;
}
const personOf = (people: PersonMap, login: string): RepoPerson =>
  people.get(login.toLowerCase()) ?? { login, handle: null, name: null, color: null };

// ── issues: the latest snapshot per issue, as of a moment ────────────────────
interface OpenIssue { number: number; labels: string[] }

/** The issues whose LATEST captured snapshot at `asOf` says `open`. Reads the
 *  state/labels with json_extract so the (large) issue bodies never leave D1. */
async function openIssuesAsOf(db: DB, asOf: string): Promise<OpenIssue[]> {
  const rows = await all<{ ref_number: number; state: string | null; labels: string | null }>(
    db,
    `SELECT ref_number, state, labels FROM (
       SELECT ref_number,
              json_extract(raw, '$.issue.state')  AS state,
              json_extract(raw, '$.issue.labels') AS labels,
              ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY ${AT} DESC, id DESC) AS rn
         FROM events WHERE event_type = 'issue' AND ${AT} <= ?
     ) WHERE rn = 1 AND state = 'open'`,
    asOf
  );
  return rows.map((r) => ({ number: r.ref_number, labels: parseLabels(r.labels) }));
}

function parseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
const isBug = (i: OpenIssue): boolean => i.labels.some((l) => l.toLowerCase() === "bug");

// ── tickets ──────────────────────────────────────────────────────────────────
/** Open tickets now, and the NET change over the window: filed − resolved + re-opened. */
async function ticketCounts(db: DB, since: string): Promise<{ open: number; delta: number }> {
  const open = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tickets WHERE status IN ('submitted','in_progress')`);
  const filed = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tickets WHERE created_at > ?`, since);
  const moves = await first<{ resolved: number | null; reopened: number | null }>(
    db,
    `SELECT SUM(CASE WHEN to_status IN ('done','declined') AND (from_status IS NULL OR from_status NOT IN ('done','declined')) THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN from_status IN ('done','declined') AND to_status NOT IN ('done','declined') THEN 1 ELSE 0 END) AS reopened
       FROM ticket_events WHERE created_at > ?`,
    since
  );
  return { open: open?.n ?? 0, delta: (filed?.n ?? 0) - (moves?.resolved ?? 0) + (moves?.reopened ?? 0) };
}

// ── PR + issue event reads ───────────────────────────────────────────────────
interface PrRow { event_type: string; ref_number: number; subject_login: string; at: string; title: string | null; url: string | null; base: string | null }
interface IssueRow { ref_number: number; subject_login: string; at: string; action: string | null; title: string | null; url: string | null; author: string | null }

const PR_COLS = `event_type, ref_number, subject_login, ${AT} AS at,
  json_extract(raw, '$.pr.title') AS title, json_extract(raw, '$.pr.html_url') AS url,
  json_extract(raw, '$.pr.base.ref') AS base`;

const prOf = (people: PersonMap, r: PrRow): RepoPr => ({
  number: r.ref_number,
  title: r.title ?? `PR #${r.ref_number}`,
  url: r.url ?? "",
  author: personOf(people, r.subject_login),
  branch: r.base ? `→ ${r.base}` : null,
  state: r.event_type === "pr_merged" ? "merged" : "closed",
  checks: null, // no check-run capture
  at: r.at,
});

/** A lower delta is good for a backlog count; a rising bug count is a warning. */
const backlogTone = (delta: number, warnOnRise: boolean): RepoTone =>
  delta < 0 ? "good" : delta > 0 && warnOnRise ? "warn" : "neutral";

/** `YYYY-MM-DD` (UTC) for each of the last `n` days, oldest first. */
function lastDays(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

function activityOf(people: PersonMap, r: IssueRow): RepoActivity | null {
  const ref = `#${r.ref_number} “${r.title ?? ""}”`;
  const base = { url: r.url, at: r.at };
  switch (r.action) {
    // `opened` is the one issue action whose actor the snapshot names (the author).
    case "opened": return { kind: "issue", actor: personOf(people, r.author ?? r.subject_login), text: `opened ${ref}`, ...base };
    case "closed": return { kind: "close", actor: null, text: `${ref} was closed`, ...base };
    case "reopened": return { kind: "issue", actor: null, text: `${ref} was reopened`, ...base };
    // An assigned event is ABOUT the assignee (its subject_login), not by them.
    case "assigned": return { kind: "review", actor: null, text: `${ref} was assigned to @${personOf(people, r.subject_login).handle ?? r.subject_login}`, ...base };
    default: return null; // edited / unassigned / (de)milestoned — noise in a feed
  }
}

export async function getRepoDashboard(db: DB, repo: string, now: number = Date.now()): Promise<RepoDashboard> {
  const nowAt = new Date(now).toISOString();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();

  const people = await personsByLogin(db);

  // Two weeks of PR closes cover the week-over-week delta AND the 14-day bars.
  const recentPrs = await all<PrRow>(
    db, `SELECT ${PR_COLS} FROM events WHERE event_type IN ('pr_merged','pr_closed') AND ${AT} > ? ORDER BY ${AT} DESC, id DESC`,
    twoWeeksAgo
  );
  // The list and the feed are NOT window-scoped: a quiet fortnight still shows the last PRs.
  const latestPrs = await all<PrRow>(
    db, `SELECT ${PR_COLS} FROM events WHERE event_type IN ('pr_merged','pr_closed') ORDER BY ${AT} DESC, id DESC LIMIT ?`, ACTIVITY_LIMIT
  );
  const listPrs = latestPrs.slice(0, PR_LIMIT);
  const merged = recentPrs.filter((p) => p.event_type === "pr_merged");
  const mergedThisWeek = merged.filter((p) => p.at > weekAgo);
  const mergedLastWeek = merged.filter((p) => p.at <= weekAgo && p.at > twoWeeksAgo);
  const closedUnmerged = recentPrs.filter((p) => p.event_type === "pr_closed" && p.at > weekAgo);

  const openNow = await openIssuesAsOf(db, nowAt);
  const openThen = await openIssuesAsOf(db, weekAgo);

  // ── repo capture (sources A, B) ───────────────────────────────────────────
  // `prCaptured` is a COMPLETENESS marker (`prs_reconciled`, written by
  // reconcileRepo only after the open-PR list is fetched AND ingested), not
  // "any pr row exists" — a single webhook delivery must not claim a complete
  // open-PR count. Same field name/shape as before; only what it gates on
  // changed.
  const prCaptured = (await getSnapshot(db, "prs_reconciled")) !== null;
  const isOpen = (r: RepoEventRow) => r.state === "draft" || r.state === "review";
  const prsNow = prCaptured ? (await prStatesAsOf(db, nowAt)).filter(isOpen) : [];
  const prsThen = prCaptured ? (await prStatesAsOf(db, weekAgo)).filter(isOpen) : [];
  const awaiting = (rows: RepoEventRow[]) => rows.filter((r) => r.state === "review").length;
  // A delta is only real once capture was RECORDING for the whole comparison
  // window — otherwise "now vs a week ago" is really "now vs whenever capture
  // began", which reads as a spurious spike. `tickets` is the fallback tile's
  // own read, so skip it entirely once PR capture makes that tile unreachable.
  const prRecordingSince = prCaptured ? await recordingSince(db, "pr") : null;
  const prDeltaOk = prRecordingSince !== null && prRecordingSince <= weekAgo;
  const tickets = prCaptured ? { open: 0, delta: 0 } : await ticketCounts(db, weekAgo);
  const pushes = await pushRowsSince(db, twoWeeksAgo);
  const pushesThisWeek = pushes.filter((p) => p.occurred_at > weekAgo);
  const sum = (rows: RepoEventRow[]) => rows.reduce((n, r) => n + (r.count ?? 0), 0);
  const commitsThisWeek = sum(pushesThisWeek);
  const commitsLastWeek = sum(pushes.filter((p) => p.occurred_at <= weekAgo));
  const pushRecordingSince = pushes.length ? await recordingSince(db, "push") : null;
  const pushDeltaOk = pushRecordingSince !== null && pushRecordingSince <= twoWeeksAgo;

  const issueEvents = await all<IssueRow>(
    db,
    `SELECT ref_number, subject_login, ${AT} AS at,
            json_extract(raw, '$.action') AS action, json_extract(raw, '$.issue.title') AS title,
            json_extract(raw, '$.issue.html_url') AS url, json_extract(raw, '$.issue.user.login') AS author
       FROM events WHERE event_type = 'issue'
        AND json_extract(raw, '$.action') IN ('opened','closed','reopened','assigned')
      ORDER BY ${AT} DESC, id DESC LIMIT ?`,
    // Enough to fill the feed AND cover a busy week of opens/closes for the tiles.
    200
  );
  const issuesThisWeek = issueEvents.filter((e) => e.at > weekAgo);
  const openedThisWeek = issuesThisWeek.filter((e) => e.action === "opened");
  const closedThisWeek = issuesThisWeek.filter((e) => e.action === "closed");

  // ── Overview tiles ────────────────────────────────────────────────────────
  const bugsNow = openNow.filter(isBug).length;
  const bugsThen = openThen.filter(isBug).length;
  const issueTiles: RepoStat[] = [
    { label: "Open issues", value: openNow.length, delta: openNow.length - openThen.length, tone: backlogTone(openNow.length - openThen.length, false) },
    { label: "Open bugs", value: bugsNow, delta: bugsNow - bugsThen, tone: backlogTone(bugsNow - bugsThen, true) },
  ];
  // Until PR state has been captured (or backfilled) an "Open PRs: 0" would be a lie.
  const stats: RepoStat[] = prCaptured
    ? [
        { label: "Open PRs", value: prsNow.length, delta: prDeltaOk ? prsNow.length - prsThen.length : 0, tone: "neutral" },
        { label: "Awaiting review", value: awaiting(prsNow), delta: prDeltaOk ? awaiting(prsNow) - awaiting(prsThen) : 0, tone: "neutral" },
        ...issueTiles,
      ]
    : [
        { label: "Merged PRs", value: mergedThisWeek.length, delta: mergedThisWeek.length - mergedLastWeek.length, tone: "neutral" },
        ...issueTiles,
        { label: "Open tickets", value: tickets.open, delta: tickets.delta, tone: backlogTone(tickets.delta, false) },
      ];

  // ── Code ──────────────────────────────────────────────────────────────────
  const mergers = new Set(mergedThisWeek.map((p) => p.subject_login.toLowerCase())).size;
  const commitDelta = commitsThisWeek - commitsLastWeek;
  const codeStats: RepoCodeStat[] = [
    prCaptured
      ? { label: "Open PRs", value: prsNow.length, sub: `${awaiting(prsNow)} awaiting review`, tone: "neutral" }
      : { label: "Closed unmerged", value: closedUnmerged.length, sub: "this week", tone: "neutral" },
    { label: "Merged this week", value: mergedThisWeek.length, sub: mergers === 0 ? "this week" : mergers === 1 ? "by 1 person" : `by ${mergers} people`, tone: "neutral" },
    pushes.length
      ? {
          label: "Commits this week", value: commitsThisWeek,
          sub: pushDeltaOk ? `${commitDelta >= 0 ? "▲" : "▼"} ${Math.abs(commitDelta)} vs last week` : "this week",
          tone: "neutral",
        }
      : { label: "Issues opened", value: openedThisWeek.length, sub: "this week", tone: "neutral" },
    { label: "Issues closed", value: closedThisWeek.length, sub: "this week", tone: "neutral" },
  ];

  // Commits once pushes are captured; merges (what `events` has always had) until then.
  const commitDays = pushes.length ? await commitsByDay(db, twoWeeksAgo) : null;
  const perDay = new Map<string, number>();
  for (const p of merged) perDay.set(p.at.slice(0, 10), (perDay.get(p.at.slice(0, 10)) ?? 0) + 1);
  const days = lastDays(now, BAR_DAYS).map((date) => ({ date, count: (commitDays ?? perDay).get(date) ?? 0 }));
  const barTotal = days.reduce((n, d) => n + d.count, 0);
  const noun = commitDays ? "commit" : "merged PR";
  const bars: RepoBars = {
    title: `${commitDays ? "Commit" : "Merge"} activity — last ${BAR_DAYS} days`,
    note: `${barTotal} ${noun}${barTotal === 1 ? "" : "s"} · all branches`,
    days,
  };

  // ── Activity: PR closes + issue moves, one time-ordered feed ──────────────
  const prActivity: RepoActivity[] = latestPrs.map((p) => ({
    kind: p.event_type === "pr_merged" ? "merge" as const : "close" as const,
    // The capture names the PR's AUTHOR, not who pressed merge — so say whose it is.
    actor: null,
    text: `#${p.ref_number} “${p.title ?? ""}” by @${personOf(people, p.subject_login).handle ?? p.subject_login} was ${p.event_type === "pr_merged" ? "merged" : "closed unmerged"}`,
    url: p.url, at: p.at,
  }));
  const issueActivity = issueEvents.map((e) => activityOf(people, e)).filter((a): a is RepoActivity => a !== null);
  // A backfilled push is a synthetic count-1 row PER COMMIT (40 real commits
  // become 40 rows), so it would flood the feed with lines a real push never
  // produces — keep the feed to what the webhook actually saw.
  const pushActivity: RepoActivity[] = pushes.filter((p) => p.provenance === "webhook").slice(0, ACTIVITY_LIMIT).map((p) => ({
    kind: "push" as const, actor: p.actor_login ? personOf(people, p.actor_login) : null,
    text: `pushed ${p.count ?? 0} commit${p.count === 1 ? "" : "s"} to ${p.ref ?? "a branch"}`, url: p.url, at: p.occurred_at,
  }));
  const activity = prActivity.concat(issueActivity, pushActivity)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT);

  // ── Team & Planning ───────────────────────────────────────────────────────
  const tally = new Map<string, { login: string; pushes: number; merged: number; reviews: number }>();
  const bump = (login: string, key: "pushes" | "merged" | "reviews") => {
    const k = login.toLowerCase();
    const row = tally.get(k) ?? { login, pushes: 0, merged: 0, reviews: 0 };
    row[key] += 1;
    tally.set(k, row);
  };
  // A bot's pushes are not a person's week; nor is a backfilled one — a
  // 40-commit backfilled push would tally P=40 for one person against a real
  // push's P=1 for the same 40 commits.
  for (const p of pushesThisWeek) if (p.actor_login && !p.actor_login.endsWith("[bot]") && p.provenance === "webhook") bump(p.actor_login, "pushes");
  for (const p of mergedThisWeek) bump(p.subject_login, "merged");
  // `reviews` has no capture path yet (Phase 2) — every tally is 0, which would
  // render as a real "0 reviews" column. Show it only once a `review` row has
  // ever been captured; until then it is `null` (never guessed).
  const hasReviewCapture = await hasCaptured(db, "review");
  const contributors: RepoContributor[] = [...tally.values()]
    .sort((a, b) => (b.pushes + b.merged + b.reviews) - (a.pushes + a.merged + a.reviews) || a.login.localeCompare(b.login))
    .slice(0, CONTRIBUTOR_LIMIT)
    .map((t) => ({ person: personOf(people, t.login), pushes: t.pushes, merged: t.merged, reviews: hasReviewCapture ? t.reviews : null }));

  const byLabel = new Map<string, number>();
  for (const i of openNow) for (const l of i.labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
  const labels: RepoLabels = {
    total: openNow.length,
    rows: [...byLabel.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, LABEL_LIMIT),
  };

  // The sprint a person marked active (roadmap order) — never inferred from dates.
  const current = (await list_sprints(db)).find((sp) => sp.active) ?? null;
  const sprint: RepoSprint | null = current
    ? { id: current.id, label: current.label, due: current.due, closed: current.progress.closed, total: current.progress.total, pct: current.progress.pct }
    : null;

  const PR_STATES = ["draft", "review", "approved", "merged", "closed"] as const;
  const isKnownPrState = (s: string | null): s is RepoPr["state"] => (PR_STATES as readonly string[]).includes(s ?? "");
  const capturedPrs: RepoPr[] = prCaptured
    ? (await recentPrRows(db, PR_LIMIT))
        // An unrecognized state is dropped, never guessed as "awaiting review".
        .filter((r) => isKnownPrState(r.state))
        .map((r) => ({
          number: r.number ?? 0, title: r.title ?? `PR #${r.number}`, url: r.url ?? "",
          author: personOf(people, r.actor_login ?? "unknown"), branch: r.ref,
          state: r.state as RepoPr["state"],
          checks: null, at: r.occurred_at,
        }))
    : listPrs.map((p) => prOf(people, p));

  const some = <T>(rows: T[]): RepoSection<T[]> => (rows.length ? ok(rows) : EMPTY);
  return {
    repo, generatedAt: nowAt, degraded: false, ...UNCAPTURED,
    stats: ok(stats),
    codeStats: ok(codeStats),
    bars: barTotal > 0 ? ok(bars) : EMPTY,
    prs: some(capturedPrs),
    activity: some(activity),
    sprint: sprint ? ok(sprint) : EMPTY,
    contributors: some(contributors),
    labels: labels.rows.length ? ok(labels) : EMPTY,
  };
}
