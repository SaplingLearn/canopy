// Every SELECT over the repo capture tables. D1 only — nothing here may fetch.
import { type DB, all, first, fanOut, ph } from "../db";
import type { RepoDeploy } from "@shared/repo";
import type { RepoEventKind, RepoEventRow, RepoPart, RepoPrRow, RepoReviewRow, RepoRunRow } from "./types";

/** The columns a `pr` reader needs — never `raw`, and never the columns no PR
 *  reader touches. Shared by `prStatesAsOf` / `recentPrRows` so both stay
 *  narrow the same way. */
const PR_ROW_COLS = "number, state, ref, sha, actor_login, title, url, occurred_at";

export async function hasCaptured(db: DB, kind: RepoEventKind): Promise<boolean> {
  return (await first<{ n: number }>(db, `SELECT 1 AS n FROM repo_events WHERE kind = ? LIMIT 1`, kind)) !== null;
}

/** When capture of `kind` began recording (the earliest `recorded_at`, NOT
 *  `occurred_at` — a backfilled row's occurred_at can predate capture
 *  entirely). `SELECT MIN(...)` always returns a row, so an empty table
 *  comes back as `{ at: null }`, not no row — normalize that to `null`. Used
 *  to decide whether a week-over-week delta is real or an artifact of when
 *  capture started. */
export async function recordingSince(db: DB, kind: RepoEventKind): Promise<string | null> {
  const row = await first<{ at: string | null }>(db, `SELECT MIN(recorded_at) AS at FROM repo_events WHERE kind = ?`, kind);
  return row?.at ?? null;
}

/** The latest `pr` row per PR number as of a moment — a PR's state THEN. Long-
 *  open PRs must still resolve correctly, so this is NEVER time-bound; only
 *  its columns are narrowed. */
export async function prStatesAsOf(db: DB, asOfIso: string): Promise<RepoPrRow[]> {
  return all<RepoPrRow>(db,
    `SELECT ${PR_ROW_COLS} FROM (
       SELECT ${PR_ROW_COLS}, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'pr' AND occurred_at <= ?
     ) WHERE rn = 1`, asOfIso);
}

/** The latest `pr` row per PR number, most-recently-touched first — bounded to
 *  the last 90 days: a PR nobody touched in that long need not appear in a
 *  "recent" list (unlike `prStatesAsOf`, which must stay correct for a
 *  long-open PR). */
export async function recentPrRows(db: DB, limit: number, sinceIso: string): Promise<RepoPrRow[]> {
  // Three levels: the innermost computes `rn` (its ORDER BY may reach `id` on
  // the base table); the middle filters to the latest row per PR and orders/
  // limits by it (so `id` must still be a selected column there); the outer
  // finally drops `id`, leaving exactly the narrow row type.
  return all<RepoPrRow>(db,
    `SELECT ${PR_ROW_COLS} FROM (
       SELECT id, ${PR_ROW_COLS} FROM (
         SELECT id, ${PR_ROW_COLS}, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
           FROM repo_events WHERE kind = 'pr' AND occurred_at > ?
       ) WHERE rn = 1 ORDER BY occurred_at DESC, id DESC LIMIT ?
     )`, sinceIso, limit);
}

export async function commitsByDay(db: DB, sinceIso: string): Promise<Map<string, number>> {
  const rows = await all<{ day: string; n: number }>(db,
    `SELECT substr(occurred_at, 1, 10) AS day, SUM(COALESCE(count, 0)) AS n
       FROM repo_events WHERE kind = 'push' AND occurred_at > ? GROUP BY day`, sinceIso);
  return new Map(rows.map((r) => [r.day, r.n]));
}

export async function pushRowsSince(db: DB, sinceIso: string): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM repo_events WHERE kind = 'push' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, sinceIso);
}

// ── deploys, checks, workflow runs, reviews (Task 7's capture) ───────────────
//
// Every read below is BATCHED on purpose. The dashboard renders N environments
// × 2 deployables and a page of PRs; a per-row or per-environment query would
// cost dozens of D1 round-trips on the render path. Each function here is ONE
// statement (plus, for deploy history, one pusher lookup) whatever N is.

/** How many dots one deploy strip shows. */
const DEPLOY_HISTORY = 10;

/** Only these run conclusions are decisive — a cancelled or skipped run says
 *  nothing about whether CI is healthy, so it is not in the denominator. */
const DECISIVE = ["success", "failure", "timed_out"];

/** Fold one deployment's (or one Workers Builds check run's) status rows into a
 *  single dot: a superseded deploy (success → inactive) still DEPLOYED, one
 *  that never succeeded and went inactive/cancelled was cancelled, and one
 *  still in flight is not a dot at all (null). */
function foldResult(states: string[]): RepoDeploy["result"] | null {
  if (states.includes("success")) return "ok";
  if (states.some((s) => s === "failure" || s === "error" || s === "timed_out")) return "fail";
  if (states.some((s) => s === "inactive" || s === "cancelled")) return "cancel";
  return null;
}

/** Who pushed each of these commits — the human behind a deploying bot. The
 *  FIRST push row for a sha wins (a re-push of the same head is the same
 *  person's commit). */
async function pushersFor(db: DB, shas: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(shas.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await fanOut<{ sha: string; actor_login: string }>(db, ids, (p) =>
    `SELECT sha, actor_login FROM (
       SELECT sha, actor_login, ROW_NUMBER() OVER (PARTITION BY sha ORDER BY id ASC) AS rn
         FROM repo_events WHERE kind = 'push' AND sha IN (${p})
     ) WHERE rn = 1 AND actor_login IS NOT NULL`);
  return new Map(rows.map((r) => [r.sha, r.actor_login]));
}

/** The last `limit` deploys of EVERY environment half, OLDEST first (the dots
 *  read left→right), keyed `<env>:<part>`. Backend halves come from `deploy`
 *  rows (Railway, via GitHub deployment statuses), frontend halves from the
 *  `check` rows the capture tagged with an env + `part='frontend'` (a Workers
 *  Builds run on that environment's own branch). Two queries total, however
 *  many environments there are. */
export async function deployHistories(db: DB, limit: number = DEPLOY_HISTORY): Promise<Map<string, RepoDeploy[]>> {
  const rows = await all<{ env: string; part: RepoPart; sha: string | null; states: string; at: string; actor: string | null }>(db,
    // One deployment / check run = several status rows, so fold by `number`
    // FIRST and take the per-strip window over the folded groups.
    `SELECT env, part, sha, states, at, actor FROM (
       SELECT env, part, MAX(sha) AS sha, GROUP_CONCAT(state) AS states,
              MAX(occurred_at) AS at, MIN(occurred_at) AS started, MAX(actor_login) AS actor,
              ROW_NUMBER() OVER (PARTITION BY env, part ORDER BY MIN(occurred_at) DESC) AS rn
         FROM repo_events
        WHERE kind IN ('deploy', 'check') AND env IS NOT NULL AND part IS NOT NULL
        GROUP BY env, part, number
     ) WHERE rn <= ? ORDER BY env, part, started ASC`, limit);
  const pushers = await pushersFor(db, rows.map((r) => r.sha ?? ""));
  const out = new Map<string, RepoDeploy[]>();
  for (const r of rows) {
    const result = foldResult(r.states.split(","));
    if (!result) continue; // still running — not a dot yet
    const key = `${r.env}:${r.part}`;
    const strip = out.get(key) ?? [];
    strip.push({ sha: (r.sha ?? "").slice(0, 7), at: r.at, by: pushers.get(r.sha ?? "") ?? r.actor ?? "unknown", result });
    out.set(key, strip);
  }
  return out;
}

/** The head sha of each branch, as the push capture last saw it. */
export async function branchHeads(db: DB, branches: string[]): Promise<Map<string, string>> {
  const refs = [...new Set(branches.filter(Boolean))];
  if (!refs.length) return new Map();
  const rows = await fanOut<{ ref: string; sha: string }>(db, refs, (p) =>
    `SELECT ref, sha FROM (
       SELECT ref, sha, ROW_NUMBER() OVER (PARTITION BY ref ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'push' AND ref IN (${p})
     ) WHERE rn = 1 AND sha IS NOT NULL`);
  return new Map(rows.map((r) => [r.ref, r.sha]));
}

/** The LATEST state of every check on each of these commits (a re-run
 *  supersedes its earlier result), keyed by sha. One query for every sha the
 *  render needs — the environment heads and the listed PRs' heads together. */
export async function latestChecks(db: DB, shas: string[]): Promise<Map<string, { name: string; state: string }[]>> {
  const ids = [...new Set(shas.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await fanOut<{ sha: string; name: string; state: string }>(db, ids, (p) =>
    `SELECT sha, name, state FROM (
       SELECT sha, name, state, ROW_NUMBER() OVER (PARTITION BY sha, name ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'check' AND sha IN (${p}) AND name IS NOT NULL AND state IS NOT NULL
     ) WHERE rn = 1 ORDER BY name`);
  const out = new Map<string, { name: string; state: string }[]>();
  for (const r of rows) out.set(r.sha, [...(out.get(r.sha) ?? []), { name: r.name, state: r.state }]);
  return out;
}

/** One commit's checks as a single verdict — null when nothing is captured for
 *  it, so the PR list's checks column renders nothing rather than a guess. */
export function checkState(checks: { state: string }[] | undefined): "pass" | "fail" | "run" | null {
  if (!checks?.length) return null;
  if (checks.some((c) => c.state === "failure" || c.state === "timed_out")) return "fail";
  if (checks.some((c) => c.state === "pending")) return "run";
  return "pass";
}

/** PRs whose latest review per reviewer includes an approval and no standing
 *  change request. One query for the whole page of PRs. */
export async function approvedPrs(db: DB, numbers: number[]): Promise<Set<number>> {
  const ids = [...new Set(numbers.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Set();
  const rows = await fanOut<{ number: number; state: string }>(db, ids, (p) =>
    `SELECT number, state FROM (
       SELECT number, state, ROW_NUMBER() OVER (PARTITION BY number, actor_login ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'review' AND state IN ('approved', 'changes_requested', 'dismissed')
          AND number IN (${p})
     ) WHERE rn = 1`);
  const blocked = new Set(rows.filter((r) => r.state === "changes_requested").map((r) => r.number));
  return new Set(rows.filter((r) => r.state === "approved" && !blocked.has(r.number)).map((r) => r.number));
}

/** The most recent failed workflow runs in the window. */
export async function ciFailureRows(db: DB, sinceIso: string, limit: number): Promise<RepoRunRow[]> {
  return all<RepoRunRow>(db,
    `SELECT name, ref, title, url, occurred_at FROM repo_events
      WHERE kind = 'run' AND state IN ('failure', 'timed_out') AND occurred_at > ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`, sinceIso, limit);
}

/** Failure rate (%) per UTC day for the last 7 days, oldest first, plus the
 *  rate over the whole window. Cancelled/skipped runs are not decisive. */
export async function ciDailyRates(db: DB, now: number): Promise<{ days: number[]; rate: number }> {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const rows = await all<{ day: string; state: string; n: number }>(db,
    `SELECT substr(occurred_at, 1, 10) AS day, state, COUNT(*) AS n FROM repo_events
      WHERE kind = 'run' AND occurred_at > ? AND state IN (${ph(DECISIVE.length)}) GROUP BY day, state`,
    since, ...DECISIVE);
  let bad = 0, total = 0;
  const days: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const of = rows.filter((r) => r.day === day);
    const t = of.reduce((n, r) => n + r.n, 0);
    const b = of.filter((r) => r.state !== "success").reduce((n, r) => n + r.n, 0);
    bad += b; total += t;
    days.push(t ? Math.round((b / t) * 1000) / 10 : 0);
  }
  return { days, rate: total ? Math.round((bad / total) * 1000) / 10 : 0 };
}

export async function reviewRowsSince(db: DB, sinceIso: string): Promise<RepoReviewRow[]> {
  return all<RepoReviewRow>(db,
    `SELECT number, state, actor_login, url, occurred_at FROM repo_events
      WHERE kind = 'review' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, sinceIso);
}
