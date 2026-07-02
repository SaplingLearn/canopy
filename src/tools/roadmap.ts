import type { MilestoneRow } from "@shared/rows";
import { type DB, all } from "../db";
// fetchMilestoneProgress moved to ./progress (Task 5, shared with the
// event-derived cache + scheduled recompute) — import it from there.
import { fetchMilestoneProgress } from "./progress";

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
