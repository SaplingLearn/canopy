// Every SELECT over the repo capture tables. D1 only — nothing here may fetch.
import { type DB, all, first } from "../db";
import type { RepoEventKind, RepoEventRow, RepoPrRow } from "./types";

/** The columns a `pr` reader needs — never `raw`, and never the columns no PR
 *  reader touches. Shared by `prStatesAsOf` / `recentPrRows` so both stay
 *  narrow the same way. */
const PR_ROW_COLS = "number, state, ref, actor_login, title, url, occurred_at";

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
