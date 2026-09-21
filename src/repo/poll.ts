// Scheduled pulls for the repo dashboard — health pings, Cloudflare Workers
// analytics, Railway CPU/memory. Each writes repo_metrics (the Cloudflare poll
// also its `cf_polled` snapshot); none may throw — a dead target or a bad token
// costs one data point, never the cron tick.
import type { DB } from "../db";
import type { RepoEnvConfig } from "./config";
import { getSnapshot, putMetric, putSnapshot } from "./store";
import { CF_POLLED, type CfPolled } from "./types";

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
 * The window is LAGGED one hour, and that is load-bearing: `putMetric` is
 * first-write-wins, so a short count written once is PERMANENT — and this runs
 * at minute 0, seconds after the newest hour closes, when Cloudflare's adaptive
 * dataset may not have caught up with it yet. So `to` is the current hour's
 * floor MINUS an hour and the window is the 3 hours before it: every bucket has
 * had at least an hour to settle before its one and only write. The overlap
 * heals a missed tick, `INSERT OR IGNORE` dedupes it — but `datetime_leq: $to`
 * is INCLUSIVE, so the bucket AT `to` can come back and is skipped here, as is
 * anything outside the window.
 *
 * Never throws. One request per environment, sequentially (2 today). A non-2xx,
 * a thrown fetch, a 200 whose body carries a non-empty `errors` array (how
 * GraphQL reports a failure) or a body with no account in it (nothing was
 * looked at) is logged and costs THAT environment this tick's points — `data`
 * beside `errors` is never read — and the loop moves on. A malformed row is
 * skipped on its own and never aborts the rows after it.
 *
 * A quiet hour has NO row (the dataset groups invocations; none → no group), so
 * an absent hour is not written as 0 here — the projection zero-fills instead
 * (src/tools/repo.ts). But "no row" only means "zero" for an hour a poll is
 * KNOWN to have looked at, so each environment whose poll SUCCEEDED — even with
 * zero rows — is recorded as polled through `to` in the ONE `cf_polled`
 * snapshot: ONE read-modify-write per call, after the loop (read, merge every
 * environment that succeeded, write once) — no read when none succeeded, no
 * write unless a bound actually advanced. A failed environment keeps its
 * previous bound, and a bound never moves BACKWARDS (compared as parsed
 * instants). A failure here is logged and costs only the marker.
 */
export async function pollCloudflare(
  db: DB, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<void> {
  const to = Math.floor(now / HOUR) * HOUR - HOUR;
  const from = to - CF_HOURS * HOUR;
  const succeeded: string[] = [];
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
      // No account matched (a wrong account id, a token that cannot see it):
      // the Worker was never looked at, so this is NOT "polled and found quiet".
      if (!Array.isArray(rows)) throw new Error("cloudflare analytics: no account in the response");
      for (const row of rows) {
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
      succeeded.push(cfg.key);
    } catch (e) {
      console.error("pollCloudflare", cfg.key, e);
    }
  }
  if (!succeeded.length) return;
  try {
    const bounds: CfPolled = { ...record((await getSnapshot<unknown>(db, CF_POLLED))?.data) } as CfPolled;
    let advanced = false;
    for (const key of succeeded) {
      const prev = typeof bounds[key] === "string" ? Date.parse(bounds[key]) : NaN;
      if (Number.isFinite(prev) && prev >= to) continue;
      bounds[key] = new Date(to).toISOString();
      advanced = true;
    }
    if (advanced) await putSnapshot(db, CF_POLLED, bounds, new Date(now).toISOString());
  } catch (e) {
    console.error("pollCloudflare", CF_POLLED, e);
  }
}

// ── Railway CPU and memory (source L) ────────────────────────────────────────
const RW_GRAPHQL = "https://backboard.railway.com/graphql/v2";
const RW_TIMEOUT_MS = 10_000;
const RW_HOURS = 3;
const RW_QUERY = `query($e:String!,$s:String!,$start:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$start,measurements:[CPU_USAGE,MEMORY_USAGE_GB],sampleRateSeconds:3600){measurement values{ts value}}}`;
/** Railway measurement → the metric it is stored as, the ceiling above which a
 *  value is not believed (1024 vCPU / 4096 GB — sanity bounds, far past any
 *  plan), and the unit it is stored in: CPU as vCPU, memory as MB to one
 *  decimal (Railway reports GB). Anything not named here is ignored. */
const RW_MEASUREMENTS: Record<string, { metric: string; max: number; store: (v: number) => number }> = {
  CPU_USAGE: { metric: "rw_cpu", max: 1024, store: (v) => v },
  MEMORY_USAGE_GB: { metric: "rw_mem_mb", max: 4096, store: (v) => Math.round(v * 1024 * 10) / 10 },
};

/**
 * Hourly `rw_cpu` (vCPU) / `rw_mem_mb` per environment's BACKEND service,
 * `env` = the config key, `part` = "backend".
 *
 * `tokens[cfg.key]` is THAT environment's Railway PROJECT token — one token
 * reaches one environment of one project, and it travels as
 * `Project-Access-Token`, never `Authorization` (that header is for account /
 * workspace tokens; a project token is refused there). An environment with no
 * token, no `railwayEnvironmentId` or no `railwayServiceId` is skipped; the
 * others still poll. NOTHING here may log a token: only `cfg.key` and the
 * error's message reach the console, and the message is scrubbed of every
 * token in the map in case a failure ever quotes the request back.
 *
 * Only COMPLETE hours are stored: `putMetric` is first-write-wins, so a partial
 * sample written once is permanent — any value stamped at or after the current
 * hour's floor is skipped and picked up by a later tick instead. (Unlike
 * Cloudflare's counts these are gauges averaged per sample, so there is no
 * ingestion-lag undercount and no extra hour of lag.) The window asked for is
 * the 3 hours before that floor: the overlap heals a missed tick, `INSERT OR
 * IGNORE` dedupes it. Each sample is bucketed to its hour, so the UNIQUE key
 * holds one point per hour whatever second Railway stamps it with.
 *
 * Never throws. One request per environment, sequentially (2 today). A non-2xx,
 * a thrown fetch, a 200 whose body carries a non-empty `errors` array (how
 * GraphQL reports a failure — including a token this query is not permitted
 * to) or a body with no metrics list is logged and costs THAT environment this
 * tick's points — `data` beside `errors` is never read — and the loop moves on;
 * the hosting block then stays `not_connected`, never guessed. A malformed or
 * implausible value is skipped on its own and never aborts the rows after it.
 */
export async function pollRailway(
  db: DB, tokens: Record<string, string | undefined>, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<void> {
  const to = Math.floor(now / HOUR) * HOUR;
  const from = to - RW_HOURS * HOUR;
  for (const cfg of envs) {
    const token = tokens[cfg.key];
    if (!token || !cfg.railwayEnvironmentId || !cfg.railwayServiceId) continue;
    try {
      const res = await fetchImpl(RW_GRAPHQL, {
        method: "POST",
        signal: AbortSignal.timeout(RW_TIMEOUT_MS),
        headers: { "Project-Access-Token": token, "content-type": "application/json", "user-agent": "canopy-hosting" },
        body: JSON.stringify({ query: RW_QUERY, variables: { e: cfg.railwayEnvironmentId, s: cfg.railwayServiceId, start: new Date(from).toISOString() } }),
      });
      if (!res.ok) throw new Error(`railway metrics ${res.status}`);
      const body = record(await res.json());
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new Error(`railway metrics: ${String(record(body.errors[0]).message ?? "graphql error").slice(0, 200)}`);
      }
      const series = record(body.data).metrics;
      if (!Array.isArray(series)) throw new Error("railway metrics: no metrics in the response");
      for (const entry of series) {
        const { measurement, values } = record(entry);
        const spec = typeof measurement === "string" && Object.hasOwn(RW_MEASUREMENTS, measurement) ? RW_MEASUREMENTS[measurement] : null;
        if (!spec || !Array.isArray(values)) continue;
        for (const v of values) {
          const { ts, value } = record(v);
          // `ts` is unix SECONDS. A partial hour (>= `to`), anything before the
          // window asked for, and anything that is not a plausible gauge reading
          // is skipped — never stored, never NaN.
          if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
          const at = Math.floor((ts * 1000) / HOUR) * HOUR;
          if (!Number.isFinite(at) || at < from || at >= to) continue;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > spec.max) continue;
          await putMetric(db, { metric: spec.metric, env: cfg.key, part: "backend", value: spec.store(value), at: new Date(at).toISOString() });
        }
      }
    } catch (e) {
      // The message only — never the error object, the request init or a header.
      let message = e instanceof Error ? e.message : String(e);
      for (const secret of Object.values(tokens)) if (secret) message = message.split(secret).join("[redacted]");
      console.error("pollRailway", cfg.key, message);
    }
  }
}
