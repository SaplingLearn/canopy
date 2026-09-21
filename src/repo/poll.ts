// Scheduled pulls for the repo dashboard — health pings, Cloudflare Workers
// analytics, Railway CPU/memory, Sapling's active users. Each writes
// repo_metrics (the Cloudflare poll also its `cf_polled` snapshot); none may
// throw — a dead target or a bad token costs one data point, never the cron tick.
import type { DB } from "../db";
import type { RepoEnvConfig } from "./config";
import { getSnapshot, putMetric, putSnapshot } from "./store";
import { CF_POLLED, CF_POLL_HOURS, cfCovered, type CfPolled } from "./types";

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
 * zero rows — has this window `[from, to)` merged into its covered INTERVAL in
 * the ONE `cf_polled` snapshot (`{ [env]: { from, to } }`): when the previous
 * interval reaches this window (`prev.to >= from`) it keeps its `from` and its
 * `to` becomes `max(prev.to, to)`; otherwise — no previous interval, or a GAP,
 * i.e. an outage longer than the 3-hour window left hours nothing ever looked
 * at — the interval RESTARTS at this window's `from`. That jump is the record
 * of the hole: the projection never draws a zero before `from`. ONE
 * read-modify-write per call, after the loop (read, merge every environment
 * that succeeded, write once) — no read when none succeeded, no write unless an
 * interval actually changed. A failed environment keeps its previous interval,
 * and neither end ever moves BACKWARDS (compared as parsed instants). A legacy
 * string entry is read through `cfCovered` and rewritten as an interval the
 * first time it advances. A failure here is logged and costs only the marker.
 */
export async function pollCloudflare(
  db: DB, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<void> {
  const to = Math.floor(now / HOUR) * HOUR - HOUR;
  const from = to - CF_POLL_HOURS * HOUR;
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
        // KNOWN LIMIT (accepted): a row IN the window that is malformed is skipped,
        // but the environment still counts as polled below — so that one hour may
        // be drawn as 0 rather than unknown. It takes Cloudflare changing its
        // response types; the blast radius is one bucket, and totals (sums of
        // real points) are unaffected. The fix, if it ever matters: remember the
        // first malformed in-window hour and end this poll's covered `to` there.
        if (!Number.isFinite(at) || at < from || at >= to || requests === null || errors === null) continue;
        const iso = new Date(at).toISOString();
        await putMetric(db, { metric: "cf_requests", env: cfg.key, part: "frontend", value: requests, at: iso });
        await putMetric(db, { metric: "cf_errors", env: cfg.key, part: "frontend", value: errors, at: iso });
      }
      succeeded.push(cfg.key);
    } catch (e) {
      // The message only — never the error object, the request init or a header
      // — scrubbed of the token in case a failure ever quotes the request back
      // (the same rule `pollRailway` and `pollSaplingMetrics` keep below).
      const message = e instanceof Error ? e.message : String(e);
      console.error("pollCloudflare", cfg.key, (cf.token ? message.split(cf.token).join("[redacted]") : message).slice(0, 200));
    }
  }
  if (!succeeded.length) return;
  try {
    // A read-modify-write with no lock, which is safe only because ticks do not
    // overlap (hourly, against ~10s timeouts per environment) — and a lost update
    // would be harmless anyway: every writer inside one hour computes the SAME
    // window, so the loser's interval is re-written identically next tick.
    const bounds = { ...record((await getSnapshot<unknown>(db, CF_POLLED))?.data) } as Record<string, unknown>;
    let changed = false;
    for (const key of succeeded) {
      const prev = cfCovered(bounds[key]);
      const next = prev && prev.to >= from ? { from: prev.from, to: Math.max(prev.to, to) } : { from, to };
      if (prev && next.from === prev.from && next.to === prev.to) continue;
      bounds[key] = { from: new Date(next.from).toISOString(), to: new Date(next.to).toISOString() };
      changed = true;
    }
    if (changed) await putSnapshot(db, CF_POLLED, bounds as CfPolled, new Date(now).toISOString());
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
 * holds one point per hour whatever second Railway stamps it with — and when
 * one response holds several valid samples for one bucket, the LATEST `ts`
 * is the one written (see the pick below), not whichever came first.
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
      // ONE row per metric per hour bucket, and WITHIN one response the sample
      // with the LATEST `ts` is the one kept — Railway's array order is
      // undocumented, and with `INSERT OR IGNORE` writing as it went, whichever
      // sample happened to come first won. The pick is made among VALID samples
      // only (every skip rule below runs before it), across every series entry
      // of the response; on an exact `ts` tie the first seen stays. This settles
      // ONE response only: a row an EARLIER poll already stored for that bucket
      // still wins (`putMetric` is first-write-wins across polls, unchanged).
      const picked = new Map<string, { metric: string; at: number; ts: number; value: number }>();
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
          const key = `${spec.metric}|${at}`;
          const held = picked.get(key);
          if (!held || ts > held.ts) picked.set(key, { metric: spec.metric, at, ts, value: spec.store(value) });
        }
      }
      for (const p of picked.values()) {
        await putMetric(db, { metric: p.metric, env: cfg.key, part: "backend", value: p.value, at: new Date(p.at).toISOString() });
      }
    } catch (e) {
      // The message only — never the error object, the request init or a header.
      let message = e instanceof Error ? e.message : String(e);
      for (const secret of Object.values(tokens)) if (secret) message = message.split(secret).join("[redacted]");
      console.error("pollRailway", cfg.key, message);
    }
  }
}

// ── Sapling active users (source M) ──────────────────────────────────────────
const SAPLING_METRICS_PATH = "/api/internal/metrics";
const SAPLING_RANGES = ["24h", "7d", "30d"] as const;
/** A sanity ceiling, far past any plausible user count — `repo_metrics` is
 *  append-only, so an absurd number written once would be permanent. */
const SAPLING_MAX_USERS = 10_000_000;
const SAPLING_BODY_LOG_CHARS = 80;

/**
 * The three windows of a Sapling metrics body, or the reason it is refused.
 * THE WHOLE RESPONSE OR NOTHING: each of `24h` / `7d` / `30d` must be a JSON
 * number that is a non-negative INTEGER ≤ `SAPLING_MAX_USERS` (a string, a
 * float, a negative, null and a missing key are all refused), AND the windows
 * must nest — `24h ≤ 7d ≤ 30d`, which distinct-users-in-a-trailing-window
 * guarantees by construction. Numbers that contradict each other are not
 * evidence, so one bad window refuses the other two as well. Pure.
 */
function saplingActiveUsers(body: unknown): { values: number[] } | { refused: string } {
  const users = record(body).active_users;
  if (!users || typeof users !== "object" || Array.isArray(users)) return { refused: "no active_users object" };
  const values: number[] = [];
  for (const range of SAPLING_RANGES) {
    const v = (users as Record<string, unknown>)[range];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SAPLING_MAX_USERS) {
      return { refused: `active_users.${range} is not an integer in 0–${SAPLING_MAX_USERS} (${v === null ? "null" : typeof v})` };
    }
    values.push(v);
  }
  if (values[0] > values[1] || values[1] > values[2]) return { refused: "the windows do not nest (24h ≤ 7d ≤ 30d)" };
  return { values };
}

/**
 * Hourly `active_users_24h` / `_7d` / `_30d` per environment, `env` = the
 * config key, `part` = "". Canopy cannot compute these — only Sapling's
 * database knows who signed in — so each environment's BACKEND is asked:
 * `GET {apiUrl}/api/internal/metrics`, `Authorization: Bearer <token>`, and a
 * `200` carrying `{ "active_users": { "24h": n, "7d": n, "30d": n } }` (the
 * contract: docs/superpowers/specs/2026-09-20-sapling-metrics-endpoint.md).
 *
 * THE TOKEN GOES TO ONE PLACE. The URL is `apiUrl` (trailing slashes dropped)
 * plus the fixed path; an `apiUrl` that is not `https:` is never fetched — a
 * bearer token is not sent in clear — and `redirect: "manual"` plus "only a
 * 200 is an answer" means a 3xx is a failure, never a hop that would carry the
 * header somewhere else. NOTHING here may log the token, a header or the
 * request init: only `cfg.key` and a short message reach the console, and the
 * message is scrubbed of the token in case a failure ever quotes it back. A
 * refused body is quoted to at most 80 characters.
 *
 * `at` is the CURRENT hour's floor, with NO lag and no complete-hours rule —
 * unlike the two pollers above. Those store per-hour sums/averages, where a
 * partial hour written once is permanently short. This is a point-in-time
 * GAUGE the endpoint computes at request time ("distinct users in the trailing
 * 24h, as of now"), so there is no partial-hour problem: the reading is whole
 * the moment it is taken, the hour is only its label, and `INSERT OR IGNORE`
 * keeps the FIRST reading of each hour.
 *
 * Never throws. One request per environment, sequentially (2 today). Anything
 * but a valid 200 — a non-200, a thrown fetch, a body that is not JSON or fails
 * `saplingActiveUsers` — is logged and writes NOTHING for that environment this
 * tick; the loop moves on, and Active users reads "not connected" — or, once a
 * reading HAS landed and is over 3 hours old, "no recent reading"
 * (src/tools/repo.ts's `seen`).
 */
export async function pollSaplingMetrics(
  db: DB, token: string, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch
): Promise<void> {
  const at = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
  // Scrubbed BEFORE it is cut: cutting first could leave half a token behind.
  const scrub = (s: string) => (token ? s.split(token).join("[redacted]") : s);
  const excerpt = (s: string) => scrub(s).slice(0, SAPLING_BODY_LOG_CHARS);
  for (const cfg of envs) {
    try {
      const base = cfg.apiUrl.replace(/\/+$/, "");
      let protocol = "";
      try { protocol = new URL(base).protocol; } catch { /* not a URL: refused below */ }
      if (protocol !== "https:") throw new Error("apiUrl is not an https URL — not fetched");
      const res = await fetchImpl(base + SAPLING_METRICS_PATH, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, "user-agent": "canopy-metrics" },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error(`body is not JSON: ${excerpt(text)}`); }
      const parsed = saplingActiveUsers(body);
      if ("refused" in parsed) throw new Error(`${parsed.refused}: ${excerpt(text)}`);
      for (const [i, range] of SAPLING_RANGES.entries()) {
        await putMetric(db, { metric: `active_users_${range}`, env: cfg.key, part: "", value: parsed.values[i], at });
      }
    } catch (e) {
      // The message only — never the error object, the request init or a header.
      console.error("pollSaplingMetrics", cfg.key, scrub(e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
  }
}
