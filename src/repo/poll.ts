// Scheduled pulls for the repo dashboard. Each writes repo_metrics; none may throw
// — a dead target or a bad token costs one data point, never the cron tick.
import type { DB } from "../db";
import type { RepoEnvConfig } from "./config";
import { putMetric } from "./store";

const TEN_MIN = 600_000;
const PING_TIMEOUT_MS = 8_000;

/** Two targets per environment: the Cloudflare frontend and the Railway
 *  backend's health path. Polite: GET, an 8s timeout, follows redirects, a
 *  distinct user-agent, no retries. Every target is pinged CONCURRENTLY
 *  (`Promise.all`) — sequentially, four dead targets would burn 4 × the timeout
 *  before the tick's real work; each target still times ITSELF, so `health_ms`
 *  is unaffected by the concurrency.
 *
 *  NOTE on what "up" means here: `redirect: "follow"` + `res.ok` counts a
 *  redirect that LANDS on a 200 page as up — an apex that 301s to www, or a
 *  frontend that bounces an unauthenticated visitor to a sign-in page, reads as
 *  healthy. It is a reachability check, not a content check.
 *
 *  `at` is the 10-minute bucket the whole ping run shares; `putMetric`
 *  normalises it, and every read of `repo_metrics` (`latestMetric` /
 *  `metricSeries` / `latestHealth`) compares that one format as a raw string. */
export async function pingHealth(db: DB, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const at = new Date(Math.floor(now / TEN_MIN) * TEN_MIN).toISOString();
  const targets = envs.flatMap((cfg) =>
    ([["frontend", cfg.frontendUrl], ["backend", cfg.apiUrl + cfg.healthPath]] as const).map(([part, url]) => ({ env: cfg.key, part, url }))
  );
  const readings = await Promise.all(targets.map(async (t) => {
    const started = Date.now();
    let up = 0;
    try {
      const res = await fetchImpl(t.url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { "user-agent": "canopy-health" },
      });
      up = res.ok ? 1 : 0;
    } catch {
      up = 0; // a thrown fetch (timeout, DNS, connection refused) is "down", never an exception out of the cron
    }
    return { ...t, up, ms: Date.now() - started };
  }));
  for (const r of readings) {
    await putMetric(db, { metric: "health_up", env: r.env, part: r.part, value: r.up, at });
    await putMetric(db, { metric: "health_ms", env: r.env, part: r.part, value: r.ms, at });
  }
}
