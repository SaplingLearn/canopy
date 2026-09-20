// Scheduled pulls for the repo dashboard. Each writes repo_metrics; none may throw
// — a dead target or a bad token costs one data point, never the cron tick.
import type { DB } from "../db";
import type { RepoEnvConfig } from "./config";
import { putMetric } from "./store";

const TEN_MIN = 600_000;
const PING_TIMEOUT_MS = 8_000;

/** Two targets per environment: the Cloudflare frontend and the Railway
 *  backend's health path. Polite: GET, an 8s timeout, follows redirects, a
 *  distinct user-agent, no retries. `at` is the 10-minute bucket the whole
 *  ping run shares, as a full `toISOString()` value — every read of
 *  `repo_metrics` (`latestMetric` / `metricSeries`) assumes that one format. */
export async function pingHealth(db: DB, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const at = new Date(Math.floor(now / TEN_MIN) * TEN_MIN).toISOString();
  for (const cfg of envs) {
    for (const [part, url] of [["frontend", cfg.frontendUrl], ["backend", cfg.apiUrl + cfg.healthPath]] as const) {
      const started = Date.now();
      let up = 0;
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
          headers: { "user-agent": "canopy-health" },
        });
        up = res.ok ? 1 : 0;
      } catch {
        up = 0; // a thrown fetch (timeout, DNS, connection refused) is "down", never an exception out of the cron
      }
      await putMetric(db, { metric: "health_up", env: cfg.key, part, value: up, at });
      await putMetric(db, { metric: "health_ms", env: cfg.key, part, value: Date.now() - started, at });
    }
  }
}
