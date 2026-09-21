// One cron trigger, several cadences, dispatched here by the minute/hour of the
// fire time (cron expressions are static UTC — the cadence lives in code, not
// in wrangler.toml). This replaced the old "0 */6 * * *" progress-only
// trigger, so the trigger count stays at three (Cloudflare bills per Worker).
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

/**
 * The repo trigger's dispatcher. REPO_CRON gives six ticks an hour and the jobs
 * are spread ACROSS them — ONE heavy job per invocation, never stacked.
 *
 * Cloudflare caps a Worker invocation at 50 SUBREQUESTS (outbound `fetch`; D1
 * calls do not count) on the free plan, so the budget, counted from the code:
 *
 *   every tick   health pings — 2 per environment (`pingHealth`), 4 today.
 *   :00          the hourly-polls slot, and nothing else may run on this
 *                tick. Three pollers, each its own `safely` arm (one failing
 *                never skips another): `pollCloudflare` — 1 GraphQL request
 *                per environment (2 today), skipped entirely unless BOTH
 *                `CF_ANALYTICS_TOKEN` and `CF_ANALYTICS_ACCOUNT_ID` are set;
 *                `pollRailway` — 1 GraphQL request per environment that HAS a
 *                project token (`RAILWAY_TOKEN_<KEY>`, ≤2 today), skipped
 *                entirely when none does; and `pollSaplingMetrics` — 1 GET per
 *                environment (2 today; `redirect: "manual"`, so never a second
 *                hop), skipped entirely unless `SAPLING_METRICS_TOKEN` is set.
 *                So this tick is health 2N + Cloudflare N + Railway N +
 *                Sapling N = 5N requests for N environments: 10 today.
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
    const { CF_ANALYTICS_TOKEN: token, CF_ANALYTICS_ACCOUNT_ID: accountId } = env;
    if (token && accountId) {
      await safely("cloudflare", () => pollCloudflare(env.DB, { token, accountId }, envs, scheduledTime, fetchImpl));
    }
    // Railway: a token PER environment; an environment without one is skipped
    // inside the poller, and with none at all the poller is not called.
    const railway = railwayTokens(env, envs);
    if (Object.values(railway).some(Boolean)) {
      await safely("railway", () => pollRailway(env.DB, railway, envs, scheduledTime, fetchImpl));
    }
    // Sapling's active users: ONE token for every environment. Absent or empty
    // → not called, and Active users stays "not connected".
    const sapling = env.SAPLING_METRICS_TOKEN;
    if (sapling) {
      await safely("sapling", () => pollSaplingMetrics(env.DB, sapling, envs, scheduledTime, fetchImpl));
    }
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
