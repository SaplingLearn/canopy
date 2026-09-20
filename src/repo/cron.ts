// One cron trigger, three cadences, dispatched here by the minute/hour of the
// fire time (cron expressions are static UTC — the cadence lives in code, not
// in wrangler.toml). This replaced the old "0 */6 * * *" progress-only
// trigger, so the trigger count stays at three (Cloudflare bills per Worker).
import type { Env } from "../env";
import { recomputeAllProgress } from "../tools/progress";
import { repoEnvironments } from "./config";
import { reconcileRepo } from "./github";
import { pingHealth } from "./poll";
import { pruneRepoCapture } from "./store";

export const REPO_CRON = "*/10 * * * *";

export async function handleRepoCron(env: Env, scheduledTime: number, fetchImpl?: typeof fetch): Promise<void> {
  const envs = repoEnvironments(env);
  const when = new Date(scheduledTime);
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
  if (when.getUTCMinutes() !== 0) return;

  // hourly polls land here in a later phase

  if (when.getUTCHours() % 6 !== 0) return;
  if (env.GITHUB_SERVICE_TOKEN && env.GITHUB_REPO) {
    const gh = { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO, fetchImpl };
    // The progress backstop this trigger has always run.
    await safely("progress", () => recomputeAllProgress(env.DB, gh));
    // reconcileRepo already covers drift and branches as arms (and writes
    // env_heads) — calling refreshDrift/refreshBranches here too would double
    // the requests, not add coverage.
    await safely("reconcile", async () => {
      const res = await reconcileRepo(env.DB, gh, envs, scheduledTime);
      if (res.failed.length) console.error("repo cron reconcile: arms failed", res.failed);
    });
  }
  await safely("prune", () => pruneRepoCapture(env.DB, scheduledTime));
}
