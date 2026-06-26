import type { MilestoneRow } from "@shared/rows";
import { type DB, all } from "../db";

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

export type MilestoneWithProgress = MilestoneRow & {
  progress: { closed: number; total: number } | null;
};

/**
 * LOCAL DEV ONLY: deterministic demo progress for a milestone, used when there is no
 * GitHub token so `wrangler dev` can render populated progress bars. Gated behind
 * DEV_LOGIN at the call site, so it never runs in production (where progress is computed
 * live from GitHub). Done → fully closed; in-progress → partway; upcoming → not started.
 */
function devProgress(m: MilestoneRow): { closed: number; total: number } {
  const total = 4 + (Number(m.id) % 6); // 4..9, stable per milestone
  if (m.status === "done") return { closed: total, total };
  if (m.status === "in_progress") return { closed: Math.max(1, Math.round(total * 0.55)), total };
  return { closed: 0, total }; // upcoming
}

/**
 * Read the roadmap: live milestones in target-date order, each merged with live
 * GitHub progress. Stores nothing. With no token or no repo, progress is null for all
 * (clean fallback seam); a per-milestone GitHub failure yields null for that one only.
 */
export async function list_roadmap(
  db: DB,
  opts: { token?: string | null; repo?: string; fetchImpl?: typeof fetch; devSynthesize?: boolean } = {}
): Promise<MilestoneWithProgress[]> {
  const milestones = await all<MilestoneRow>(
    db,
    `SELECT * FROM milestones ORDER BY target_date ASC, id ASC`
  );
  if (!opts.token || !opts.repo) {
    // No live GitHub access. In local dev (devSynthesize, gated by DEV_LOGIN at the caller)
    // fill plausible demo progress so the roadmap UI is exercisable; otherwise null — prod
    // degrades gracefully since progress is computed live and never stored.
    return milestones.map((m) => ({ ...m, progress: opts.devSynthesize ? devProgress(m) : null }));
  }
  const out: MilestoneWithProgress[] = [];
  for (const m of milestones) {
    const progress = m.github_ref
      ? await fetchMilestoneProgress({ token: opts.token, repo: opts.repo, ref: m.github_ref, fetchImpl: opts.fetchImpl })
      : null;
    out.push({ ...m, progress });
  }
  return out;
}
