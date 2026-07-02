import type { MilestoneRow, MilestoneProgressRow } from "@shared/rows";
import { type DB, all, run, nowIso } from "../db";
import { progressFromIssueEvent } from "../webhook";

const GH_API = "application/vnd.github+json";
const USER_AGENT = "canopy";

/**
 * Live progress for a milestone's github_ref, computed from GitHub at read time.
 * `ref` is JSON: a number (a GitHub milestone) or an array of issue numbers.
 * Never throws — returns null on parse failure, a non-OK response (expired/revoked
 * token, missing resource), or any error, so /roadmap degrades gracefully.
 * `fetchImpl` is injectable for tests (the pool has no exported fetch mock).
 */
export async function fetchMilestoneProgress(opts: {
  token: string;
  repo: string;
  ref: string;
  fetchImpl?: typeof fetch;
}): Promise<{ closed: number; total: number } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, accept: GH_API, "user-agent": USER_AGENT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.ref);
  } catch {
    return null;
  }

  try {
    if (Array.isArray(parsed)) {
      let closed = 0;
      let total = 0;
      for (const n of parsed) {
        const res = await doFetch(`https://api.github.com/repos/${opts.repo}/issues/${n}`, { headers });
        if (!res.ok) {
          // Token/auth-level failure → the whole milestone's progress is unknown.
          if (res.status === 401 || res.status === 403) return null;
          // A single missing/inaccessible issue (e.g. 404) → skip it; keep counting the rest.
          continue;
        }
        const data = (await res.json()) as { state?: string };
        if (data.state === "closed") closed++;
        total++;
      }
      return { closed, total };
    }
    if (typeof parsed === "number") {
      const res = await doFetch(`https://api.github.com/repos/${opts.repo}/milestones/${parsed}`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { open_issues?: number; closed_issues?: number };
      const closed = data.closed_issues ?? 0;
      return { closed, total: (data.open_issues ?? 0) + closed };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Absolute overwrite of one milestone's cached progress. `closed`/`total` are
 * always the FULL current counts (never deltas), so replays and out-of-order
 * writes are all safe — the last write simply wins.
 */
export async function upsertProgress(
  db: DB,
  milestoneId: number,
  closed: number,
  total: number,
  source: "event" | "recompute"
): Promise<void> {
  await run(
    db,
    `INSERT INTO milestone_progress (milestone_id, closed, total, source, computed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(milestone_id) DO UPDATE SET
       closed = excluded.closed,
       total = excluded.total,
       source = excluded.source,
       computed_at = excluded.computed_at`,
    milestoneId,
    closed,
    total,
    source,
    nowIso()
  );
}

/** The full progress cache, keyed by milestone id. */
export async function getProgress(db: DB): Promise<Map<number, MilestoneProgressRow>> {
  const rows = await all<MilestoneProgressRow>(db, `SELECT * FROM milestone_progress`);
  return new Map(rows.map((r) => [r.milestone_id, r]));
}

// Latest-snapshot SQL: for a set of issue numbers, the most-recently-captured
// 'issue' event per ref_number (occurred_at DESC, id DESC as the tiebreak).
function latestIssueSnapshotSql(count: number): string {
  const placeholders = Array(count).fill("?").join(", ");
  return `
    SELECT ref_number, raw FROM (
      SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
      FROM events WHERE event_type = 'issue' AND ref_number IN (${placeholders})
    ) WHERE rn = 1
  `;
}

/**
 * The webhook-side write: derive this issue event's implication for every
 * milestone it can affect, and upsert an absolute progress row for each.
 *
 * (a) Milestone-number ref: progressFromIssueEvent(payload) reads the issue's
 *     own milestone counts (open + closed = total) — authoritative, no query needed.
 * (b) Array ref: for every milestone whose github_ref is a JSON array containing
 *     this event's issue number, recount from the LATEST captured snapshot of
 *     each array member (total = array length; closed = how many of those
 *     latest snapshots have state:"closed").
 *
 * Never throws on a malformed payload — both branches simply no-op.
 */
export async function applyEventProgress(db: DB, payload: unknown): Promise<void> {
  const derived = progressFromIssueEvent(payload);
  if (derived) {
    const matches = await all<MilestoneRow>(
      db,
      `SELECT * FROM milestones WHERE github_ref = ?`,
      JSON.stringify(derived.milestoneNumber)
    );
    for (const m of matches) {
      await upsertProgress(db, m.id, derived.closed, derived.total, "event");
    }
  }

  const issueNumber =
    payload !== null && typeof payload === "object"
      ? (payload as { issue?: { number?: number } }).issue?.number
      : undefined;
  if (typeof issueNumber !== "number") return;

  const candidates = await all<MilestoneRow>(db, `SELECT * FROM milestones WHERE github_ref IS NOT NULL`);
  for (const m of candidates) {
    let ref: unknown;
    try {
      ref = JSON.parse(m.github_ref!);
    } catch {
      continue;
    }
    if (!Array.isArray(ref) || !ref.includes(issueNumber)) continue;

    const rows = ref.length > 0 ? await all<{ ref_number: number; raw: string }>(db, latestIssueSnapshotSql(ref.length), ...ref) : [];
    let closed = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.raw) as { issue?: { state?: string } };
        if (parsed.issue?.state === "closed") closed++;
      } catch {
        // malformed snapshot — treat as not-closed rather than throw
      }
    }
    await upsertProgress(db, m.id, closed, ref.length, "event");
  }
}

/**
 * Scheduled backstop: recompute every milestone-with-a-github_ref's progress
 * live from GitHub and overwrite the cache with source:'recompute'. A milestone
 * whose fetch fails (expired token, GitHub outage, …) is left with its existing
 * cache row untouched — this never wipes progress, and never 500s.
 */
export async function recomputeAllProgress(
  db: DB,
  opts: { token: string; repo: string; fetchImpl?: typeof fetch }
): Promise<{ updated: number }> {
  const milestones = await all<MilestoneRow>(db, `SELECT * FROM milestones WHERE github_ref IS NOT NULL`);
  let updated = 0;
  for (const m of milestones) {
    const progress = await fetchMilestoneProgress({
      token: opts.token,
      repo: opts.repo,
      ref: m.github_ref!,
      fetchImpl: opts.fetchImpl,
    });
    if (progress) {
      await upsertProgress(db, m.id, progress.closed, progress.total, "recompute");
      updated++;
    }
  }
  return { updated };
}
