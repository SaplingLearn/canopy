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

// ── Cloudflare Workers analytics (source K) ──────────────────────────────────
const HOUR = 3_600_000;
const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const CF_TIMEOUT_MS = 10_000;
const CF_HOURS = 3;
/** Cloudflare's schema spells its scalar `string`, LOWERCASE — `String!` is
 *  rejected as an unknown type. `Time` is theirs too. `limit: 100` is far more
 *  than the ≤4 hourly groups one Worker can return for this window. */
const CF_QUERY = `query($a: string!, $s: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour }
      sum { requests errors }
    }
  } }
}`;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
/** A count Cloudflare reported: a finite, non-negative number — anything else is not a count. */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Hourly `cf_requests` / `cf_errors` per environment's FRONTEND Worker
 * (`cfg.worker`), `env` = the config key, `part` = "frontend".
 *
 * Only COMPLETE hours are stored, and that is load-bearing: `putMetric` is
 * first-write-wins, so a partial count written once is PERMANENT. The window is
 * the 3 hours before the current hour's floor (`to`) — the overlap heals a
 * missed tick, `INSERT OR IGNORE` dedupes it — but `datetime_leq: $to` is
 * INCLUSIVE, so the bucket AT `to` (the hour in progress) can come back and is
 * skipped here, as is anything outside the window.
 *
 * Never throws. One request per environment, sequentially (2 today). A non-2xx,
 * a thrown fetch, or a 200 whose body carries a non-empty `errors` array (how
 * GraphQL reports a failure) is logged and costs THAT environment this tick's
 * points — `data` beside `errors` is never read — and the loop moves on. A
 * malformed row is skipped on its own and never aborts the rows after it.
 *
 * A quiet hour has NO row (the dataset groups invocations; none → no group), so
 * an absent hour is not written as 0 here — the projection zero-fills between
 * captured points instead (src/tools/repo.ts).
 */
export async function pollCloudflare(
  db: DB, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<void> {
  const to = Math.floor(now / HOUR) * HOUR;
  const from = to - CF_HOURS * HOUR;
  for (const cfg of envs) {
    if (!cfg.worker) continue;
    try {
      const res = await fetchImpl(CF_GRAPHQL, {
        method: "POST",
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json", "user-agent": "canopy-analytics" },
        body: JSON.stringify({ query: CF_QUERY, variables: { a: cf.accountId, s: cfg.worker, from: new Date(from).toISOString(), to: new Date(to).toISOString() } }),
      });
      if (!res.ok) throw new Error(`cloudflare analytics ${res.status}`);
      const body = record(await res.json());
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new Error(`cloudflare analytics: ${String(record(body.errors[0]).message ?? "graphql error").slice(0, 200)}`);
      }
      const accounts = record(record(body.data).viewer).accounts;
      const rows = Array.isArray(accounts) ? record(accounts[0]).workersInvocationsAdaptive : null;
      for (const row of Array.isArray(rows) ? rows : []) {
        const hour = record(record(row).dimensions).datetimeHour;
        const at = typeof hour === "string" ? Date.parse(hour) : NaN;
        const sum = record(record(row).sum);
        const requests = count(sum.requests);
        const errors = count(sum.errors);
        if (!Number.isFinite(at) || at < from || at >= to || requests === null || errors === null) continue;
        const iso = new Date(at).toISOString();
        await putMetric(db, { metric: "cf_requests", env: cfg.key, part: "frontend", value: requests, at: iso });
        await putMetric(db, { metric: "cf_errors", env: cfg.key, part: "frontend", value: errors, at: iso });
      }
    } catch (e) {
      console.error("pollCloudflare", cfg.key, e);
    }
  }
}
