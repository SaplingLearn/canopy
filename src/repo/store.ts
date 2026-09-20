import { type DB, all, first, run, nowIso, ph } from "../db";
import type { RepoMetric } from "./types";

const DAY = 86_400_000;
/** High-frequency series and rows that lose their value quickly. Deliberately
 *  does NOT cover `pr` / `push` — those stay forever (the dashboard's
 *  week-over-week deltas and 14-day bars read them). Called every 6-hourly
 *  tick of the repo cron (src/repo/cron.ts). */
const FAST_METRICS = ["health_up", "health_ms"];
const FAST_KINDS = ["check"];
const FAST_RETENTION_DAYS = 45;

export async function putSnapshot(db: DB, kind: string, data: unknown, now: string = nowIso()): Promise<void> {
  await run(db,
    `INSERT INTO repo_snapshots (kind, json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`,
    kind, JSON.stringify(data), now);
}

export async function getSnapshot<T>(db: DB, kind: string): Promise<{ data: T; computedAt: string } | null> {
  const row = await first<{ json: string; computed_at: string }>(db, `SELECT json, computed_at FROM repo_snapshots WHERE kind = ?`, kind);
  if (!row) return null;
  try { return { data: JSON.parse(row.json) as T, computedAt: row.computed_at }; } catch { return null; }
}

/** First write wins: a redelivered status or a double-fired cron is a no-op. */
export async function putMetric(db: DB, m: RepoMetric): Promise<void> {
  await run(db, `INSERT OR IGNORE INTO repo_metrics (metric, env, part, value, at) VALUES (?, ?, ?, ?, ?)`,
    m.metric, m.env, m.part, m.value, m.at);
}

export async function metricSeries(db: DB, metric: string, env: string, part: string, sinceIso: string): Promise<{ at: string; value: number }[]> {
  return all<{ at: string; value: number }>(db,
    `SELECT at, value FROM repo_metrics WHERE metric = ? AND env = ? AND part = ? AND at >= ? ORDER BY at ASC`,
    metric, env, part, sinceIso);
}

export async function latestMetric(db: DB, metric: string, env: string, part: string): Promise<{ at: string; value: number } | null> {
  return first<{ at: string; value: number }>(db,
    `SELECT at, value FROM repo_metrics WHERE metric = ? AND env = ? AND part = ? ORDER BY at DESC LIMIT 1`, metric, env, part);
}

export async function pruneRepoCapture(db: DB, now: number): Promise<void> {
  const cutoff = new Date(now - FAST_RETENTION_DAYS * DAY).toISOString();
  await run(db, `DELETE FROM repo_metrics WHERE metric IN (${ph(FAST_METRICS.length)}) AND at < ?`, ...FAST_METRICS, cutoff);
  // `part IS NULL` only: a `check` row carrying a `part` (a Workers Builds run
  // tagged as a frontend deploy — see the migration's column notes) is a
  // DEPLOY record and must be kept forever like `deploy` rows, or the
  // frontend dot strip would age out asymmetrically from the backend's.
  await run(db, `DELETE FROM repo_events WHERE kind IN (${ph(FAST_KINDS.length)}) AND part IS NULL AND occurred_at < ?`, ...FAST_KINDS, cutoff);
}
