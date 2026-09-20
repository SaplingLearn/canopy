// Every SELECT over the repo capture tables. D1 only — nothing here may fetch.
import { type DB, all, first } from "../db";
import type { RepoEventKind, RepoEventRow } from "./types";

export async function hasCaptured(db: DB, kind: RepoEventKind): Promise<boolean> {
  return (await first<{ n: number }>(db, `SELECT 1 AS n FROM repo_events WHERE kind = ? LIMIT 1`, kind)) !== null;
}

/** The latest `pr` row per PR number as of a moment — a PR's state THEN. */
export async function prStatesAsOf(db: DB, asOfIso: string): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'pr' AND occurred_at <= ?
     ) WHERE rn = 1`, asOfIso);
}

export async function recentPrRows(db: DB, limit: number): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'pr'
     ) WHERE rn = 1 ORDER BY occurred_at DESC, id DESC LIMIT ?`, limit);
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
