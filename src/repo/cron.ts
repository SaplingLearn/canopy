// One cron trigger, several cadences, dispatched here by the minute/hour of the
// fire time (cron expressions are static UTC — the cadence lives in code, not
// in wrangler.toml). This replaced the old "0 */6 * * *" progress-only
// trigger, so the trigger count stays at three (Cloudflare bills per Worker).
import type { PollOutcome, RepoRefreshResult, UsagePollResult, UsagePollSource } from "@shared/repo";
import type { Env } from "../env";
import { recomputeAllProgress } from "../tools/progress";
import { repoEnvironments, type RepoEnvConfig } from "./config";
import { run } from "../db";
import { reconcileRepo, scrubbedMessage } from "./github";
import { HEALTH_ON_DEMAND_BUCKET_MS, pingHealth, pollCloudflare, pollRailway, pollSaplingMetrics } from "./poll";
import { getSnapshot, pruneRepoCapture } from "./store";

export const REPO_CRON = "*/10 * * * *";

/** Each environment's Railway PROJECT token, keyed by `cfg.key`: the secret
 *  named `RAILWAY_TOKEN_<KEY>` (key upper-cased, anything outside A–Z/0–9 → `_`)
 *  — `RAILWAY_TOKEN_STAGING`, `RAILWAY_TOKEN_PRODUCTION`. A project token
 *  reaches ONE environment, so there is no shared one; a third environment is
 *  its secret and nothing here. The ONE place `Env` is indexed by a computed
 *  name — hence the narrow cast, and the string check on what comes back.
 *  Exported for its test only. */
export function railwayTokens(env: Env, envs: RepoEnvConfig[]): Record<string, string | undefined> {
  const bag = env as unknown as Record<string, unknown>;
  return Object.fromEntries(envs.map((cfg) => {
    const value = bag[`RAILWAY_TOKEN_${cfg.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    return [cfg.key, typeof value === "string" && value ? value : undefined];
  }));
}

export type { RepoRefreshResult, UsagePollResult };

/** What a source reports when its arm threw — the pollers never throw, so this
 *  should be unreachable; it names no cause on purpose (nothing unscrubbed may
 *  reach the response). */
const UNEXPECTED: PollOutcome[] = [{ env: "*", status: "failed", written: 0, detail: "unexpected error" }];

/**
 * The three HOURLY usage pollers, in one place: the repo cron's minute-0 tick
 * calls this, and so does the admin-only `POST /admin/poll-usage` ("Poll usage
 * now") — ONE function, so an on-demand run is the cron's own run, with its
 * outcomes handed back instead of only logged. A source whose credentials are
 * absent is `"not_configured"` and is not called (its sections stay
 * `not_connected`); each of the others runs in its OWN guarded arm — a throw
 * (the pollers never throw, so: unreachable) is logged exactly as the cron's
 * `safely` logs it and reported as `UNEXPECTED`, never skipping the next.
 *
 * `now` may be ANY instant: every poller keys its window on the HOUR FLOOR of
 * `now`, and every write is `INSERT OR IGNORE` (`putMetric`, first-write-wins),
 * so an on-demand run at :37 asks for the same hours and writes the same rows
 * the :00 tick of that hour did — idempotent with the cron, in either order.
 *
 * Subrequests: Cloudflare N + Railway ≤N + Sapling N = 3N for N environments
 * (6 today), no health pings — far inside the 50 of one invocation.
 *
 * The result carries outcomes and NEVER a token, a header or an account id: a
 * `detail` is a poller's scrubbed, truncated message, or a few fixed words.
 */
export async function runUsagePolls(env: Env, now: number, fetchImpl?: typeof fetch): Promise<UsagePollResult> {
  const envs = repoEnvironments(env);
  const arm = async (label: string, fn: () => Promise<PollOutcome[]>): Promise<UsagePollSource> => {
    try {
      return await fn();
    } catch (e) {
      console.error("repo cron", label, e);
      return UNEXPECTED;
    }
  };
  // Cloudflare: BOTH values, or not called.
  const { CF_ANALYTICS_TOKEN: token, CF_ANALYTICS_ACCOUNT_ID: accountId } = env;
  const cloudflare = token && accountId
    ? await arm("cloudflare", () => pollCloudflare(env.DB, { token, accountId }, envs, now, fetchImpl))
    : "not_configured";
  // Railway: a token PER environment; an environment without one is skipped
  // inside the poller, and with none at all the poller is not called.
  const tokens = railwayTokens(env, envs);
  const railway = Object.values(tokens).some(Boolean)
    ? await arm("railway", () => pollRailway(env.DB, tokens, envs, now, fetchImpl))
    : "not_configured";
  // Sapling's active users AND product metrics (one response carries both):
  // ONE token for every environment. Absent or empty → not called, and Active
  // users / the Product blocks stay "not connected".
  const saplingToken = env.SAPLING_METRICS_TOKEN;
  const sapling = saplingToken
    ? await arm("sapling", () => pollSaplingMetrics(env.DB, saplingToken, envs, now, fetchImpl))
    : "not_configured";
  return { cloudflare, railway, sapling };
}

/** The free plan's cap on outbound `fetch` per invocation (D1 does not count). */
export const SUBREQUEST_CAP = 50;
/** `runRepoRefresh`'s worst case for N environments: health 2N + usage 3N +
 *  reconcile (17 + 2N) = 17 + 7N. 31 for two; 45 at N = 4; 52 at N = 5. */
export const refreshSubrequests = (n: number): number => 17 + 7 * n;
/** The one fixed phrase `github.failed` carries when the arm was not run. */
export const BUDGET_SKIP = "skipped: would exceed the subrequest budget";

/**
 * EVERYTHING the Repo dashboard shows, refreshed on demand — the function
 * behind the admin's "Poll now" (`POST /admin/poll`). Three sources, in this
 * order, each in its OWN guarded arm (a failure in one never skips another):
 *
 *   health   `pingHealth`, stamped to the MINUTE (see `HEALTH_ON_DEMAND_BUCKET_MS`
 *            — inside the cron's ten-minute bucket a first-write-wins reading
 *            would be dropped). `"not_configured"` with no environment.
 *   usage    `runUsagePolls`, unchanged — Cloudflare, Railway, the app's metrics.
 *   github   `reconcileRepo` with the service token: deploys, checks, runs,
 *            branches, drift, open PRs, env heads. `"not_configured"` without
 *            `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`; an unexpected throw →
 *            `failed: ["unexpected error"]` (reconcile's own arms never throw
 *            out of it — they land in `failed` by NAME).
 *
 * THE CRON DOES NOT CALL THIS. `handleRepoCron` below spreads one heavy job per
 * tick because the jobs together did not fit an invocation; this function fits
 * only because it leaves the unbounded one out. The on-demand budget, counted
 * from the code: health 2N + usage 3N + reconcile (17 + 2N) = **17 + 7N**
 * subrequests — 31 for today's two environments, and the free plan's 50 caps
 * it at **N ≤ 4** (45; N = 5 is 52). Past that the GITHUB arm is SKIPPED and
 * says so (`BUDGET_SKIP`) rather than risk the whole invocation dying half-way
 * — health and usage (5N) still run. The formula is the worst case on purpose:
 * it does not discount an unconfigured poller.
 *
 * Deliberately NOT here:
 *   `recomputeAllProgress`  UNBOUNDED — one request per issue number of every
 *                           array-ref sprint; it is the reason the cron gives it
 *                           a tick of its own, and it feeds the Roadmap, not
 *                           this dashboard.
 *   `pruneRepoCapture`      maintenance, not a refresh — nothing on screen
 *                           changes because old rows were deleted.
 *   `runBackfill`/summaries that is "Sync GitHub": My Work's capture, with its
 *                           own Gemini budget loop.
 *
 * The result carries outcomes and NEVER a token, a header or an account id:
 * health details are fixed words, usage details are the pollers' scrubbed
 * messages, and `github.failed` is arm names or one of two fixed phrases.
 * (`reconcile` is a test seam: every arm of the real one is guarded, so the
 * "unexpected error" path cannot be reached through it.)
 */
export async function runRepoRefresh(env: Env, now: number, fetchImpl?: typeof fetch, reconcile: typeof reconcileRepo = reconcileRepo): Promise<RepoRefreshResult> {
  const envs = repoEnvironments(env);

  let health: UsagePollSource = "not_configured";
  if (envs.length) {
    try {
      health = await pingHealth(env.DB, envs, now, fetchImpl, HEALTH_ON_DEMAND_BUCKET_MS);
    } catch (e) {
      console.error("repo refresh", "health", e instanceof Error ? e.message : String(e));
      health = UNEXPECTED;
    }
  }

  let usage: UsagePollResult;
  try {
    usage = await runUsagePolls(env, now, fetchImpl);
  } catch (e) {
    // Unreachable today (runUsagePolls is total, and its arms scrub their own
    // logs) — so the message is NOT logged: nothing here knows what to scrub.
    console.error("repo refresh", "usage", e instanceof Error ? e.name : "error");
    usage = { cloudflare: UNEXPECTED, railway: UNEXPECTED, sapling: UNEXPECTED };
  }

  const { GITHUB_SERVICE_TOKEN: token, GITHUB_REPO: repo } = env;
  let github: RepoRefreshResult["github"] = "not_configured";
  if (token && repo) {
    if (refreshSubrequests(envs.length) > SUBREQUEST_CAP) {
      github = { written: 0, unchanged: 0, failed: [BUDGET_SKIP] };
    } else {
      try {
        const res = await reconcile(env.DB, { token, repo, fetchImpl }, envs, now);
        if (res.failed.length) console.error("repo refresh reconcile: arms failed", res.failed);
        github = { written: res.written, unchanged: res.unchanged, failed: res.failed };
      } catch (e) {
        console.error("repo refresh", "github", scrubbedMessage(e, token));
        github = { written: 0, unchanged: 0, failed: ["unexpected error"] };
      }
    }
  }

  return { health, ...usage, github };
}

// ── the refresh lock ─────────────────────────────────────────────────────────
/** A `repo_snapshots` row, NOT a dashboard section: `{ by, at }` while a refresh
 *  runs. Every write the refresh makes is idempotent, so two overlapping runs
 *  are CORRECT — the lock only stops a pile-up (two admins, a double click from
 *  two tabs) from spending the subrequest budget twice for nothing. */
export const REFRESH_LOCK = "refresh_lock";
/** Longer than a refresh with every fetch hanging (≈ 64 s of pollers for two
 *  environments is the known worst case, plus reconcile); a lock older than
 *  this is a run that died without its `finally`, and is ignored. */
export const REFRESH_LOCK_MS = 90_000;

export type LockedRefresh =
  | { ok: true; result: RepoRefreshResult }
  | { ok: false; since: string };

/**
 * `runRepoRefresh` behind the lock. Taking it is ONE statement — an upsert that
 * only overwrites a row older than `REFRESH_LOCK_MS` — so two callers racing
 * cannot both win; `changes = 0` means a live lock stands, and the caller gets
 * its `since` without running anything. Released in a `finally` (so a thrown
 * arm cannot strand it), and only when the row is still OURS: a run that
 * outlived its own lock must not delete the lock of the run that replaced it.
 */
export async function runLockedRepoRefresh(env: Env, by: string, now: number, fetchImpl?: typeof fetch, refresh: typeof runRepoRefresh = runRepoRefresh): Promise<LockedRefresh> {
  const at = new Date(now).toISOString();
  const mine = JSON.stringify({ by, at });
  const staleBefore = new Date(now - REFRESH_LOCK_MS).toISOString();
  const took = await run(env.DB,
    `INSERT INTO repo_snapshots (kind, json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at
     WHERE repo_snapshots.computed_at <= ?`,
    REFRESH_LOCK, mine, at, staleBefore);
  if (!took.meta.changes) {
    const held = await getSnapshot<{ at?: unknown }>(env.DB, REFRESH_LOCK);
    return { ok: false, since: held?.computedAt ?? at };
  }
  try {
    return { ok: true, result: await refresh(env, now, fetchImpl) };
  } finally {
    await run(env.DB, `DELETE FROM repo_snapshots WHERE kind = ? AND json = ?`, REFRESH_LOCK, mine).catch(() => undefined);
  }
}

/**
 * The repo trigger's dispatcher. REPO_CRON gives six ticks an hour and the jobs
 * are spread ACROSS them — ONE heavy job per invocation, never stacked.
 *
 * Cloudflare caps a Worker invocation at 50 SUBREQUESTS (outbound `fetch`; D1
 * calls do not count) on the free plan, so the budget, counted from the code:
 *
 *   every tick   health pings — 2 per environment (`pingHealth`), 4 today.
 *   :00          the hourly-polls slot (`runUsagePolls` above — the same
 *                function the admin's "Poll usage now" runs), and nothing else
 *                may run on this tick. Three pollers, each its own guarded
 *                arm (one failing
 *                never skips another): `pollCloudflare` — 1 GraphQL request
 *                per environment (2 today), skipped entirely unless BOTH
 *                `CF_ANALYTICS_TOKEN` and `CF_ANALYTICS_ACCOUNT_ID` are set;
 *                `pollRailway` — 1 GraphQL request per environment that HAS a
 *                project token (`RAILWAY_TOKEN_<KEY>`, ≤2 today), skipped
 *                entirely when none does; and `pollSaplingMetrics` — 1 GET per
 *                environment (2 today; `redirect: "manual"`, so never a second
 *                hop), skipped entirely unless `SAPLING_METRICS_TOKEN` is set.
 *                So this tick is health 2N + Cloudflare N + Railway N +
 *                Sapling N = 5N requests for N environments: 10 today — and
 *                that 5N is a CEILING on the configuration: N ≤ 9
 *                environments stay under the free plan's 50 (a tenth lands
 *                exactly ON the cap, with no headroom for a redirect on a health
 *                ping). Wall clock, everything hanging: the pollers
 *                run one after another and each loops its environments in
 *                turn, every fetch under its own timeout — 8s health
 *                (concurrent) + 2×10s Cloudflare + 2×10s Railway + 2×8s
 *                Sapling ≈ 64s for two environments, all of it I/O wait, not
 *                CPU, and far inside the 10 minutes to the next tick.
 *   :10 (h%6)    `recomputeAllProgress` — UNBOUNDED: `fetchGithubRefProgress`
 *                issues one request per issue number of every array-ref
 *                sprint, so it gets an invocation to itself.
 *   :20 (h%6)    `reconcileRepo` — worst case 17 + 2N requests for N
 *                environments (21 today): 2 PR lists + 1 pre-capture commit
 *                window + 1 GraphQL deployments + 1 workflow-run list + ≤5 job
 *                lookups + 5 GraphQL branch pages + 2 drift compares + 2 per
 *                environment (head commit, head checks).
 *   :30 (h%6)    `pruneRepoCapture` — D1 only, no subrequests.
 *
 * Health (4) + the heaviest of those (21) leaves ample headroom; stacking all
 * three on one tick did not, and the reconcile is what died.
 */
export async function handleRepoCron(env: Env, scheduledTime: number, fetchImpl?: typeof fetch): Promise<void> {
  const envs = repoEnvironments(env);
  const when = new Date(scheduledTime);
  const minute = when.getUTCMinutes();
  const hour = when.getUTCHours();
  const safely = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error("repo cron", label, e);
    }
  };

  // Every tick: a dead target or a bad token costs one data point, never the
  // cron — pingHealth itself never throws.
  await safely("health", () => pingHealth(env.DB, envs, scheduledTime, fetchImpl));

  if (minute === 0) {
    // The hourly polls — and NOTHING else may join this tick: the slot exists
    // so these pollers get an invocation of their own. Each is skipped entirely
    // when its credentials are absent (its sections then stay not_connected).
    // The outcomes are for the on-demand route; the pollers already log every
    // failure, so the cron logs nothing new.
    await safely("usage polls", () => runUsagePolls(env, scheduledTime, fetchImpl));
    return;
  }

  if (hour % 6 !== 0) return;
  const gh = env.GITHUB_SERVICE_TOKEN && env.GITHUB_REPO
    ? { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO, fetchImpl }
    : null;

  // The progress backstop this trigger has always run — on its own invocation.
  if (minute === 10 && gh) await safely("progress", () => recomputeAllProgress(env.DB, gh));

  // reconcileRepo already covers drift and branches as arms (and writes
  // env_heads) — calling refreshDrift/refreshBranches here too would double
  // the requests, not add coverage.
  if (minute === 20 && gh) {
    await safely("reconcile", async () => {
      const res = await reconcileRepo(env.DB, gh, envs, scheduledTime);
      if (res.failed.length) console.error("repo cron reconcile: arms failed", res.failed);
    });
  }

  if (minute === 30) await safely("prune", () => pruneRepoCapture(env.DB, scheduledTime));
}
