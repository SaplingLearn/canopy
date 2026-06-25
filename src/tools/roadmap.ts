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
      for (const n of parsed) {
        const res = await doFetch(`https://api.github.com/repos/${opts.repo}/issues/${n}`, { headers });
        if (!res.ok) return null;
        const data = (await res.json()) as { state?: string };
        if (data.state === "closed") closed++;
      }
      return { closed, total: parsed.length };
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
 * Read the roadmap: live milestones in target-date order, each merged with live
 * GitHub progress. Stores nothing. With no token or no repo, progress is null for all
 * (clean fallback seam); a per-milestone GitHub failure yields null for that one only.
 */
export async function list_roadmap(
  db: DB,
  opts: { token?: string | null; repo?: string; fetchImpl?: typeof fetch } = {}
): Promise<MilestoneWithProgress[]> {
  const milestones = await all<MilestoneRow>(
    db,
    `SELECT * FROM milestones ORDER BY target_date ASC, id ASC`
  );
  if (!opts.token || !opts.repo) {
    return milestones.map((m) => ({ ...m, progress: null }));
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
