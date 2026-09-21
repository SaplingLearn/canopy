// One cron trigger, several cadences, dispatched here by the minute/hour of the
// fire time (cron expressions are static UTC — the cadence lives in code, not
// in wrangler.toml). This replaced the old "0 */6 * * *" progress-only
// trigger, so the trigger count stays at three (Cloudflare bills per Worker).
import type { PollOutcome, UsagePollResult, UsagePollSource } from "@shared/repo";
import type { Env } from "../env";
import { recomputeAllProgress } from "../tools/progress";
import { repoEnvironments, type RepoEnvConfig } from "./config";
import { reconcileRepo } from "./github";
import { pingHealth, pollCloudflare, pollRailway, pollSaplingMetrics } from "./poll";
import { pruneRepoCapture } from "./store";

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

export type { UsagePollResult };

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
