import type {
  RepoActivity, RepoBars, RepoBranches, RepoCodeStat, RepoContributor, RepoDashboard, RepoDeploy, RepoDeployRow,
  RepoDrift, RepoEnv, RepoEnvPart, RepoLabels, RepoPerson, RepoPr, RepoSection, RepoSprint, RepoStat, RepoTone,
} from "@shared/repo";
import type { PersonColor } from "@shared/rows";
import { type DB, all, first, nowIso } from "../db";
import { list_sprints } from "./sprints";
import {
  approvedPrs, branchHeads, checkState, ciDailyRates, ciFailureRows, commitsByDay, deployHistories,
  hasCaptured, latestChecks, prStatesAsOf, pushRowsSince, recentPrRows, recordingSince, reviewRowsSince,
} from "../repo/reads";
import type { RepoEnvConfig } from "../repo/config";
import { getSnapshot } from "../repo/store";
import type { RepoEventRow, RepoPrRow } from "../repo/types";

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
const CI_FAILURE_LIMIT = 5;
const BAR_DAYS = 14; // = the two-week PR window below
const RECENT_PR_DAYS = 90; // recentPrRows' bound — a PR untouched this long need not be "recent"

/** Event time: the payload's own clock, else when Canopy recorded it. */
const AT = `COALESCE(occurred_at, recorded_at)`;

const ok = <T>(data: T): RepoSection<T> => ({ status: "ok", data });
const EMPTY = { status: "empty" } as const;
const NOT_CONNECTED = { status: "not_connected" } as const;

/** The sections no capture path feeds yet. One object so the list is auditable. */
const UNCAPTURED = {
  health: NOT_CONNECTED,
  coverage: NOT_CONNECTED, bundle: NOT_CONNECTED,
  usage: NOT_CONNECTED, cloudflare: NOT_CONNECTED, hosting: NOT_CONNECTED,
  todos: NOT_CONNECTED,
} as const;

export function emptyRepoDashboard(repo: string, degraded: boolean): RepoDashboard {
  return {
    repo, generatedAt: nowIso(), degraded, ...UNCAPTURED,
    environments: NOT_CONNECTED, deploys: NOT_CONNECTED, ciFailures: NOT_CONNECTED, drift: NOT_CONNECTED,
    branches: NOT_CONNECTED,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY,
    sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
  };
}

/** Each environment ships two deployables, on two different hosts. */
const HOSTS = { backend: "Railway", frontend: "Cloudflare" } as const;
const PARTS = ["backend", "frontend"] as const;
/** The word the dot strip labels each half with: "staging · api" / "· web". */
const PART_WORD = { backend: "api", frontend: "web" } as const;

const PR_STATES = ["draft", "review", "approved", "merged", "closed"] as const;
const isKnownPrState = (s: string | null): s is RepoPr["state"] => (PR_STATES as readonly string[]).includes(s ?? "");

const REVIEW_TEXT: Record<string, string> = {
  approved: "approved", changes_requested: "requested changes on",
  commented: "commented on", dismissed: "dismissed a review on",
};

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
  checks: null, // the `events` fallback carries no head sha to look checks up by
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

export async function getRepoDashboard(
  db: DB,
  repo: string,
  now: number = Date.now(),
  /** The environments this deployment reports on (`REPO_ENVIRONMENTS`). None
   *  configured → the environment/deploy sections stay `not_connected`. */
  envs: RepoEnvConfig[] = []
): Promise<RepoDashboard> {
  const nowAt = new Date(now).toISOString();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();
  const ninetyDaysAgo = new Date(now - RECENT_PR_DAYS * DAY).toISOString();

  // Never on the render path: GitHub's GraphQL refs query is called off
  // reconcileRepo only — this only reads back the snapshot it wrote. No
  // snapshot yet → not_connected; a stale one is still shown (a fact as of
  // its own computedAt), same as `drift` below.
  const branchSnap = await getSnapshot<RepoBranches>(db, "branches");

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
  const isOpen = (r: RepoPrRow) => r.state === "draft" || r.state === "review";
  const prsNow = prCaptured ? (await prStatesAsOf(db, nowAt)).filter(isOpen) : [];
  const prsThen = prCaptured ? (await prStatesAsOf(db, weekAgo)).filter(isOpen) : [];
  // The PR list: the latest state per PR, unknown states dropped (never guessed).
  const prRows = prCaptured ? (await recentPrRows(db, PR_LIMIT, ninetyDaysAgo)).filter((r) => isKnownPrState(r.state)) : [];
  // ONE approval read for both consumers below — the listed PRs and the open-PR
  // tile. An approved PR is no longer "awaiting review".
  const approved = await approvedPrs(db, [...prsNow, ...prRows].filter((r) => r.state === "review").map((r) => r.number ?? 0));
  const awaiting = (rows: RepoPrRow[], done: Set<number> = new Set()) =>
    rows.filter((r) => r.state === "review" && !done.has(r.number ?? -1)).length;
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

  // ── environments: two deployables each (Railway backend, Cloudflare frontend) ─
  // Batched on purpose: ONE deploy-history read covering every environment and
  // both halves, ONE branch-head read, and ONE check read covering the
  // environment heads AND the listed PRs' heads together. N environments cost
  // the same three round-trips as one.
  const strips = envs.length ? await deployHistories(db) : new Map<string, RepoDeploy[]>();
  const heads = envs.length ? await branchHeads(db, envs.map((e) => e.branch)) : new Map<string, string>();
  const checks = await latestChecks(db, [...heads.values(), ...prRows.map((r) => r.sha ?? "")]);

  const deployRows: RepoDeployRow[] = [];
  const cards = envs.map((cfg) => {
    const parts: RepoEnvPart[] = PARTS.map((part) => {
      const history = strips.get(`${cfg.key}:${part}`) ?? [];
      // A half with no capture gets no dot strip at all — an empty one would
      // read as "nothing has deployed", which is not what is known.
      if (history.length) deployRows.push({ env: cfg.key, part, label: `${cfg.label} · ${PART_WORD[part]}`, deploys: history });
      const last = history[history.length - 1] ?? null;
      return { part, host: HOSTS[part], sha: last?.sha ?? null, deployedAt: last?.at ?? null, deployedBy: last?.by ?? null, result: last?.result ?? null };
    });
    const head = heads.get(cfg.branch);
    const onHead = (head ? checks.get(head) : undefined) ?? [];
    const failing = onHead.filter((c) => c.state === "failure" || c.state === "timed_out").map((c) => c.name);
    const settled = onHead.filter((c) => c.state !== "pending");
    const ci = !onHead.length ? "No checks captured"
      : failing.length ? `${failing.length} of ${onHead.length} checks failing — ${failing[0]}`
      : settled.length < onHead.length ? `${settled.length} of ${onHead.length} checks finished`
      : `All ${onHead.length} checks passing`;
    // The card is CONNECTED once anything about the environment was captured —
    // a deploy result or a head check. That is a different question from the
    // pill, which is a verdict: HEALTHY is a claim about CHECKS, so it needs
    // checks captured on the head, none of them failing, and no failed part. A
    // deploy that landed with no checks captured says only that it landed —
    // UNKNOWN, neutral. A part that FAILED is a fact on its own, so FAILING
    // does not wait for checks.
    const connected = parts.some((p) => p.result !== null) || onHead.length > 0;
    const failed = parts.some((p) => p.result === "fail");
    const card: RepoEnv = {
      key: cfg.key, name: cfg.label, note: cfg.note, parts, url: cfg.frontendUrl, ci,
      ciTone: !onHead.length ? "neutral" : failing.length ? "bad" : "good",
      pill: failed ? "FAILING" : failing.length ? "DEGRADED" : onHead.length ? "HEALTHY" : "UNKNOWN",
      tone: failed ? "bad" : failing.length ? "warn" : onHead.length ? "good" : "neutral",
    };
    return { card, connected };
  });
  const envCards: RepoEnv[] = cards.map((c) => c.card);
  const anyEnvCapture = cards.some((c) => c.connected);

  // CI is `not_connected` until a workflow run has ever been captured — a 0%
  // failure rate over nothing is a guess, not an answer. And the SEVEN-DAY rate
  // (and its per-day trend) waits for the same recording-window rule the PR and
  // commit deltas use: until `run` capture predates the whole week, a day with
  // no captured runs is a day capture was not running, not a green day. The
  // failures LIST is not gated — those rows are facts.
  const runCaptured = await hasCaptured(db, "run");
  const runRecordingSince = runCaptured ? await recordingSince(db, "run") : null;
  const ciRates = runRecordingSince !== null && runRecordingSince <= weekAgo ? await ciDailyRates(db, now) : null;
  const failureRows = runCaptured ? await ciFailureRows(db, weekAgo, CI_FAILURE_LIMIT) : [];
  const reviews = await reviewRowsSince(db, twoWeeksAgo);

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
        // The week-ago value keeps the approval-blind form on purpose: which
        // PRs were approved a week ago is not knowable from today's reviews,
        // and the delta is suppressed anyway until capture predates the window.
        { label: "Awaiting review", value: awaiting(prsNow, approved), delta: prDeltaOk ? awaiting(prsNow, approved) - awaiting(prsThen) : 0, tone: "neutral" },
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
      ? { label: "Open PRs", value: prsNow.length, sub: `${awaiting(prsNow, approved)} awaiting review`, tone: "neutral" }
      : { label: "Closed unmerged", value: closedUnmerged.length, sub: "this week", tone: "neutral" },
    { label: "Merged this week", value: mergedThisWeek.length, sub: mergers === 0 ? "this week" : mergers === 1 ? "by 1 person" : `by ${mergers} people`, tone: "neutral" },
    pushes.length
      ? {
          label: "Commits this week", value: commitsThisWeek,
          sub: pushDeltaOk ? `${commitDelta >= 0 ? "▲" : "▼"} ${Math.abs(commitDelta)} vs last week` : "this week",
          tone: "neutral",
        }
      : { label: "Issues opened", value: openedThisWeek.length, sub: "this week", tone: "neutral" },
    // Never guess: the tile is "Active branches" only once a branches
    // snapshot exists; until then it keeps its previous content.
    branchSnap
      ? { label: "Active branches", value: branchSnap.data.active, sub: `${branchSnap.data.stale} stale`, tone: branchSnap.data.stale ? "warn" : "neutral" }
      : { label: "Issues closed", value: closedThisWeek.length, sub: "this week", tone: "neutral" },
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
  const reviewActivity: RepoActivity[] = reviews.slice(0, ACTIVITY_LIMIT).map((r) => ({
    kind: "review" as const, actor: r.actor_login ? personOf(people, r.actor_login) : null,
    text: `${REVIEW_TEXT[r.state ?? "commented"] ?? "reviewed"} #${r.number ?? "?"}`, url: r.url, at: r.occurred_at,
  }));
  // A deploy line is worth a feed row only once it landed — a failed or
  // cancelled attempt belongs to the dot strip, not to "what happened".
  const deployActivity: RepoActivity[] = deployRows.flatMap((row) =>
    row.deploys.filter((d) => d.result === "ok").map((d) => ({
      kind: "deploy" as const, actor: null, text: `${d.sha} deployed to ${row.label}`, url: null, at: d.at,
    })));
  const activity = prActivity.concat(issueActivity, pushActivity, reviewActivity, deployActivity)
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
  // Same rule as the pushes above: a review bot (CodeRabbit, Copilot) is not a
  // person having a week, and would dwarf every human column.
  for (const r of reviews) if (r.occurred_at > weekAgo && r.actor_login && !r.actor_login.endsWith("[bot]")) bump(r.actor_login, "reviews");
  // A tally of 0 would render as a real "0 reviews" column. Show the count only
  // once a `review` row has ever been captured; until then it is `null` (never
  // guessed) — `reviews` in the window can legitimately be 0 for a person.
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

  // `prRows` was already read (and filtered to known states) above, so the
  // checks and approvals could be resolved for the whole page in one query each.
  const capturedPrs: RepoPr[] = prCaptured
    ? prRows.map((r) => ({
        number: r.number ?? 0, title: r.title ?? `PR #${r.number}`, url: r.url ?? "",
        author: personOf(people, r.actor_login ?? "unknown"), branch: r.ref,
        // An approval is a state the capture can prove; everything else is the
        // row's own state (an unrecognized one was dropped, never guessed).
        state: r.state === "review" && approved.has(r.number ?? -1) ? "approved" : (r.state as RepoPr["state"]),
        checks: checkState(checks.get(r.sha ?? "")), at: r.occurred_at,
      }))
    : listPrs.map((p) => prOf(people, p));

  const some = <T>(rows: T[]): RepoSection<T[]> => (rows.length ? ok(rows) : EMPTY);
  // Never on the render path: GitHub's compare API is called off a push
  // webhook or reconcileRepo, never here — this only reads back what one of
  // those already wrote. No snapshot yet → not_connected; a stale one is
  // still shown (a fact as of its own computedAt).
  const driftSnap = await getSnapshot<RepoDrift>(db, "drift");
  return {
    repo, generatedAt: nowAt, degraded: false, ...UNCAPTURED,
    drift: driftSnap ? ok(driftSnap.data) : NOT_CONNECTED,
    branches: branchSnap ? ok(branchSnap.data) : NOT_CONNECTED,
    // An environment card needs BOTH a configured environment and something
    // captured about it; a configured-but-silent environment is not connected.
    environments: envs.length && anyEnvCapture ? ok(envCards) : NOT_CONNECTED,
    deploys: deployRows.length ? ok(deployRows) : envs.length && anyEnvCapture ? EMPTY : NOT_CONNECTED,
    ciFailures: runCaptured
      ? ok({
          // null / [] until the week is covered — never a rate over a partial window.
          rate: ciRates?.rate ?? null, trend: ciRates?.days ?? [],
          rows: failureRows.map((r) => ({
            workflow: r.name ?? "workflow", branch: r.ref ?? "", job: r.title ?? "—",
            at: r.occurred_at, url: r.url ?? "",
          })),
        })
      : NOT_CONNECTED,
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
