/**
 * Task 13 — health pings and the 10-minute cron trigger.
 *
 * `pingHealth` writes the health_up/health_ms metrics one 10-minute bucket at a
 * time; `handleRepoCron` is the single repo cron trigger's dispatcher. ONE heavy
 * job per invocation, keyed off the fire time's minute/hour (see the budget
 * comment in src/repo/cron.ts): health on EVERY tick, the hourly-polls slot at
 * minute 0, and — every 6th hour — the progress backstop at :10, the GitHub
 * reconcile at :20 and the capture prune at :30, each in its own invocation.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import wranglerToml from "../wrangler.toml?raw";
import { all, run, nowIso } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { pingHealth } from "../src/repo/poll";
import { handleRepoCron, REPO_CRON } from "../src/repo/cron";
import { getRepoDashboard } from "../src/tools/repo";
import { getSnapshot, putMetric } from "../src/repo/store";
import { ENVS, fakeGithub } from "./helpers/repo";
import type { RepoEvent } from "../src/repo/types";
import type { Env } from "../src/env";

const T = Date.parse("2026-09-20T12:07:31Z");
/** The four ticks the dispatcher treats specially (F1). */
const HOURLY = Date.parse("2026-09-20T12:00:00Z");        // health + the (empty) hourly-polls slot
const PROGRESS_TICK = Date.parse("2026-09-20T12:10:00Z"); // the progress backstop, alone
const RECONCILE_TICK = Date.parse("2026-09-20T12:20:00Z");// reconcileRepo, alone
const PRUNE_TICK = Date.parse("2026-09-20T12:30:00Z");    // pruneRepoCapture (D1 only)
const NOT_SIX = Date.parse("2026-09-20T13:20:00Z");       // the same minute, a non-6-hourly hour

const ghEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r", ...over }) as unknown as Env;
/** Both Railway project tokens pinned absent: a local `.dev.vars` must not decide a test. */
const NO_RAILWAY = { RAILWAY_TOKEN_STAGING: undefined, RAILWAY_TOKEN_PRODUCTION: undefined } as const;
const okFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
const snapshots = () => all(env.DB, `SELECT 1 FROM repo_snapshots`);
const progressRows = () => all(env.DB, `SELECT 1 FROM sprint_progress`);
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };

/** A sprint whose github_ref is a one-issue array — what recomputeAllProgress reads. */
async function seedSprint(): Promise<void> {
  await run(env.DB, `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    "M", "2026-10-01", "in_progress", "[1]", nowIso(), "andres");
}

const base = { raw: "{}", provenance: "webhook" as const };
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(env.DB, r); };
const deploy = (id: number, state: string, mins: number): RepoEvent =>
  ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: "staging", part: "backend", sha: "abc", state, actor_login: "railway-app[bot]", occurred_at: new Date(T - mins * 60_000).toISOString() });

describe("pingHealth", () => {
  it("records up/ms per target in a 10-minute bucket, and a throw as down", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => {
      if (String(u) === "https://api.saplinglearn.com/api/health") throw new Error("connect timeout");
      return new Response("ok", { status: String(u).includes("staging.sapling") ? 200 : 503 });
    }) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    await pingHealth(env.DB, ENVS, T + 60_000, fetchImpl); // same bucket → no second row
    const up = await all<{ env: string; part: string; value: number; at: string }>(env.DB, `SELECT env, part, value, at FROM repo_metrics WHERE metric = 'health_up' ORDER BY env, part`);
    expect(up).toEqual([
      { env: "production", part: "backend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "production", part: "frontend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "backend", value: 1, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "frontend", value: 1, at: "2026-09-20T12:00:00.000Z" },
    ]);
  });

  // M13: the four targets are pinged CONCURRENTLY — sequentially they cost up to
  // 4 × the 8s timeout before the tick's real work starts.
  it("pings every target concurrently", async () => {
    let inFlight = 0, peak = 0;
    const fetchImpl = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    expect(peak).toBe(4);
  });

  it("feeds the health block and drags the pill to DOWN when a target is unreachable", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    const d = await getRepoDashboard(env.DB, "o/r", T, ENVS);
    const rows = ok(d.health);
    expect(rows.map((r) => [r.env, r.up])).toEqual([["staging · web", true], ["staging · api", false], ["production · web", true], ["production · api", true]]);
    // F5: the code produces DOWN (tone `bad`), never DEGRADED, for an unreachable target.
    const [staging, production] = ok(d.environments);
    expect(staging).toMatchObject({ pill: "DOWN", tone: "bad" });
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
  });

  it("DOWN outranks a failed deploy and a failing check", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: new Date(T - 40 * 60_000).toISOString() },
      deploy(1, "failure", 30),
      { ...base, semantic_key: "gh:check:9:completed", kind: "check", number: 9, name: "e2e", state: "failure", sha: "abc", ref: "main", occurred_at: new Date(T - 20 * 60_000).toISOString() },
    ]);
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "DOWN", tone: "bad" });
  });

  it("a fresh, up ping with nothing deployed or checked is UNKNOWN, never HEALTHY", async () => {
    await pingHealth(env.DB, ENVS, T, okFetch);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
  });

  // F4: connectivity for the ENVIRONMENT cards includes health; the DEPLOYS
  // fallback must not — one ping is not "no deploys recorded".
  it("a health ping alone connects the environment cards but leaves deploys not_connected", async () => {
    await pingHealth(env.DB, ENVS, T, okFetch);
    const d = await getRepoDashboard(env.DB, "o/r", T, ENVS);
    expect(d.environments.status).toBe("ok");
    expect(d.deploys.status).toBe("not_connected");
  });

  // F3: three states. A reading that has gone stale means the PINGS stopped, not
  // that they were never set up — `empty`, never `not_connected`.
  it("a health row older than 30 minutes is stale — the block is empty, not not_connected", async () => {
    const stale = T - 31 * 60_000;
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: new Date(stale).toISOString() });
    await putMetric(env.DB, { metric: "health_ms", env: "staging", part: "frontend", value: 100, at: new Date(stale).toISOString() });
    expect((await getRepoDashboard(env.DB, "o/r", T, ENVS)).health.status).toBe("empty");
  });

  it("is not_connected only when no reading has EVER landed", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", T, ENVS)).health.status).toBe("not_connected");
  });

  // F5: a stale DOWN reading cannot drag the pill — the ping stopped, the site
  // is not known to be down.
  it("a stale down reading does not produce DOWN", async () => {
    const stale = T - 31 * 60_000;
    await put([deploy(1, "success", 20)]);
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 0, at: new Date(stale).toISOString() });
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", T, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
  });
});

describe("handleRepoCron", () => {
  // M8: `src/index.ts` dispatches on exact string equality, so a wrangler.toml
  // that drifted from REPO_CRON would silently stop the health pings AND the
  // progress backstop. Assert the declaration, not just the constant.
  it("is the cron expression wrangler.toml declares", () => {
    expect(REPO_CRON).toBe("*/10 * * * *");
    expect(wranglerToml).toContain(`"${REPO_CRON}"`);
  });

  it("pings every tick; with no service token it does nothing else and never throws", async () => {
    await handleRepoCron(ghEnv({ GITHUB_SERVICE_TOKEN: undefined }), T, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at minute 0 only health runs — the hourly-polls slot carries no heavy job yet", async () => {
    await seedSprint();
    // A GitHub that would answer every arm: nothing may run here regardless.
    const gh = fakeGithub({ "/issues/1": { state: "closed" } });
    // Both analytics secrets pinned absent: a local `.dev.vars` must not decide this test.
    await handleRepoCron(ghEnv({ CF_ANALYTICS_TOKEN: undefined, CF_ANALYTICS_ACCOUNT_ID: undefined, ...NO_RAILWAY }), HOURLY, gh.fetchImpl);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
    expect(await progressRows()).toHaveLength(0);
    expect(gh.calls).toHaveLength(4); // the four health pings, nothing else
  });

  // Task 16: the hourly-polls slot. Cloudflare analytics runs at minute 0 ONLY,
  // and only when BOTH the token and the account id are set.
  describe("the hourly Cloudflare analytics poll", () => {
    const CF_URL = "https://api.cloudflare.com/client/v4/graphql";
    const cfEnv = (over: Partial<Env> = {}): Env =>
      ghEnv({ REPO_ENVIRONMENTS: JSON.stringify(ENVS), CF_ANALYTICS_TOKEN: "cf-token", CF_ANALYTICS_ACCOUNT_ID: "acct", ...NO_RAILWAY, ...over });
    /** Health pings answer 200; the analytics endpoint answers one complete hour. */
    const recorder = () => {
      const calls: string[] = [];
      const fetchImpl = (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        if (String(u) !== CF_URL) return new Response("ok", { status: 200 });
        return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
          { dimensions: { datetimeHour: "2026-09-20T10:00:00Z" }, sum: { requests: 640, errors: 3 } },
        ] }] } } }), { status: 200 });
      }) as typeof fetch;
      return { calls, fetchImpl, cf: () => calls.filter((c) => c === CF_URL) };
    };
    const cfRows = () => all<{ env: string; metric: string; value: number }>(env.DB, `SELECT env, metric, value FROM repo_metrics WHERE metric LIKE 'cf_%' ORDER BY env, metric`);

    it("at minute 0 with both values set, polls once per environment and stores the hour", async () => {
      const r = recorder();
      await handleRepoCron(cfEnv(), HOURLY, r.fetchImpl);
      expect(r.cf()).toHaveLength(2);
      expect(r.calls).toHaveLength(6); // 4 health pings + 2 analytics queries — far under the 50 cap
      expect(await cfRows()).toEqual([
        { env: "production", metric: "cf_errors", value: 3 }, { env: "production", metric: "cf_requests", value: 640 },
        { env: "staging", metric: "cf_errors", value: 3 }, { env: "staging", metric: "cf_requests", value: 640 },
      ]);
      // Still nothing ELSE on this tick: the only snapshot is the poll's own
      // polled-through marker (Task 16b), none of reconcileRepo's.
      expect(await all(env.DB, `SELECT kind FROM repo_snapshots`)).toEqual([{ kind: "cf_polled" }]);
    });

    it("at minute 10 it is not called", async () => {
      const r = recorder();
      await handleRepoCron(cfEnv(), PROGRESS_TICK, r.fetchImpl);
      expect(r.cf()).toHaveLength(0);
      expect(await cfRows()).toEqual([]);
    });

    it("with the token absent it is not called", async () => {
      const r = recorder();
      await handleRepoCron(cfEnv({ CF_ANALYTICS_TOKEN: undefined }), HOURLY, r.fetchImpl);
      expect(r.cf()).toHaveLength(0);
      expect(await cfRows()).toEqual([]);
    });

    it("with the account id absent it is not called", async () => {
      const r = recorder();
      await handleRepoCron(cfEnv({ CF_ANALYTICS_ACCOUNT_ID: undefined }), HOURLY, r.fetchImpl);
      expect(r.cf()).toHaveLength(0);
    });

    it("an analytics endpoint that throws never costs the tick", async () => {
      const fetchImpl = (async (u: RequestInfo | URL) => {
        if (String(u) === CF_URL) throw new Error("connect timeout");
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      await expect(handleRepoCron(cfEnv(), HOURLY, fetchImpl)).resolves.toBeUndefined();
      expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    });
  });

  // Task 17: Railway joins the SAME minute-0 slot, as its own arm. Each
  // environment authenticates with ITS OWN project token (`RAILWAY_TOKEN_<KEY>`).
  describe("the hourly Railway poll", () => {
    const RW_URL = "https://backboard.railway.com/graphql/v2";
    const RW_ENVS = ENVS.map((e, i) => ({ ...e, railwayEnvironmentId: `env-${i}`, railwayServiceId: "svc" }));
    const rwEnv = (over: Partial<Env> = {}): Env =>
      ghEnv({
        REPO_ENVIRONMENTS: JSON.stringify(RW_ENVS), CF_ANALYTICS_TOKEN: undefined, CF_ANALYTICS_ACCOUNT_ID: undefined,
        RAILWAY_TOKEN_STAGING: "tok-staging", RAILWAY_TOKEN_PRODUCTION: "tok-production", ...over,
      });
    /** Health pings answer 200; Railway answers one complete hour (11:00Z). */
    const recorder = () => {
      const calls: string[] = [];
      const tokens: Record<string, string | null> = {};
      const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(u));
        if (String(u) !== RW_URL) return new Response("ok", { status: 200 });
        const e = (JSON.parse(String(init?.body)) as { variables: { e: string } }).variables.e;
        tokens[e] = new Headers(init?.headers).get("project-access-token");
        return new Response(JSON.stringify({ data: { metrics: [
          { measurement: "CPU_USAGE", values: [{ ts: 1789902000, value: 0.12 }] },
          { measurement: "MEMORY_USAGE_GB", values: [{ ts: 1789902000, value: 0.4 }] },
        ] } }), { status: 200 });
      }) as typeof fetch;
      return { calls, tokens, fetchImpl, rw: () => calls.filter((c) => c === RW_URL) };
    };
    const rwRows = () => all<{ env: string; metric: string; value: number }>(env.DB, `SELECT env, metric, value FROM repo_metrics WHERE metric LIKE 'rw_%' ORDER BY env, metric`);

    it("at minute 0 polls once per environment, each with its own token, and stores the hour", async () => {
      const r = recorder();
      await handleRepoCron(rwEnv(), HOURLY, r.fetchImpl);
      expect(r.rw()).toHaveLength(2);
      expect(r.calls).toHaveLength(6); // 4 health pings + 2 Railway queries
      expect(r.tokens).toEqual({ "env-0": "tok-staging", "env-1": "tok-production" });
      expect(await rwRows()).toEqual([
        { env: "production", metric: "rw_cpu", value: 0.12 }, { env: "production", metric: "rw_mem_mb", value: 409.6 },
        { env: "staging", metric: "rw_cpu", value: 0.12 }, { env: "staging", metric: "rw_mem_mb", value: 409.6 },
      ]);
      expect(await snapshots()).toHaveLength(0); // still nothing ELSE on this tick
    });

    it("shares the slot with Cloudflare: health 2N + Cloudflare N + Railway N requests", async () => {
      const r = recorder();
      await handleRepoCron(rwEnv({ CF_ANALYTICS_TOKEN: "cf-token", CF_ANALYTICS_ACCOUNT_ID: "acct" }), HOURLY, r.fetchImpl);
      expect(r.calls).toHaveLength(8);
      expect(r.rw()).toHaveLength(2);
    });

    it("at minute 10 it is not called", async () => {
      const r = recorder();
      await handleRepoCron(rwEnv(), PROGRESS_TICK, r.fetchImpl);
      expect(r.rw()).toHaveLength(0);
      expect(await rwRows()).toEqual([]);
    });

    it("an environment with no token is skipped while the other still polls", async () => {
      const r = recorder();
      await handleRepoCron(rwEnv({ RAILWAY_TOKEN_STAGING: undefined }), HOURLY, r.fetchImpl);
      expect(r.tokens).toEqual({ "env-1": "tok-production" });
      expect((await rwRows()).map((x) => x.env)).toEqual(["production", "production"]);
    });

    it("with no token at all it is not called", async () => {
      const r = recorder();
      await handleRepoCron(rwEnv(NO_RAILWAY), HOURLY, r.fetchImpl);
      expect(r.rw()).toHaveLength(0);
      expect(await rwRows()).toEqual([]);
    });

    it("a Railway endpoint that throws never costs the tick", async () => {
      const fetchImpl = (async (u: RequestInfo | URL) => {
        if (String(u) === RW_URL) throw new Error("connect timeout");
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      await expect(handleRepoCron(rwEnv(), HOURLY, fetchImpl)).resolves.toBeUndefined();
      expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    });
  });

  it("at :10 of a 6-hourly hour the progress backstop runs, and the reconcile does not", async () => {
    await seedSprint();
    const gh = fakeGithub({ "/issues/1": { state: "closed" } });
    await handleRepoCron(ghEnv(), PROGRESS_TICK, gh.fetchImpl);
    expect(await progressRows()).toHaveLength(1);
    expect(await snapshots()).toHaveLength(0);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
  });

  it("at :20 of a 6-hourly hour the reconcile runs through the injected fetch, alone, well under the subrequest cap", async () => {
    await seedSprint();
    const gh = fakeGithub({
      "/pulls?state=open": [], "/pulls?state=closed": [],
      "/commits?sha=main&per_page=1": [{ sha: "mainhead0000001", commit: { message: "ship it", committer: { date: "2026-09-20T10:00:00Z" } }, author: { login: "AndresL230" } }],
      "/commits?sha=production&per_page=1": [{ sha: "prodhead1234567", commit: { message: "release cut", committer: { date: "2026-09-19T10:00:00Z" } }, author: { login: "AndresL230" } }],
    });
    await handleRepoCron(ghEnv(), RECONCILE_TICK, gh.fetchImpl);
    // The end-to-end cover the admin route can never have (it has no fetchImpl seam).
    expect(await getSnapshot(env.DB, "prs_reconciled")).not.toBeNull();
    expect(await getSnapshot(env.DB, "env_heads")).not.toBeNull();
    expect(await getSnapshot(env.DB, "drift")).not.toBeNull();
    expect(await getSnapshot(env.DB, "branches")).not.toBeNull();
    // Health still pinged on the same tick.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    // The progress backstop is NOT stacked on this invocation (F1): it is
    // unbounded — one fetch per issue number of every array-ref sprint.
    expect(await progressRows()).toHaveLength(0);
    // Cloudflare caps one invocation at 50 subrequests on the free plan; every
    // outbound fetch of this tick went through the injected impl.
    expect(gh.calls.length).toBeLessThan(50);
  });

  it("at :20 with no service token, only health runs and no snapshot is written", async () => {
    await handleRepoCron(ghEnv({ GITHUB_SERVICE_TOKEN: undefined }), RECONCILE_TICK, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at :30 of a 6-hourly hour the prune runs, and the reconcile does not", async () => {
    const old = new Date(PRUNE_TICK - 100 * 24 * 60 * 60 * 1000).toISOString(); // past the 45-day retention
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: old });
    await handleRepoCron(ghEnv(), PRUNE_TICK, okFetch);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up' AND at = ?`, old)).length).toBe(0);
    expect(await snapshots()).toHaveLength(0);
  });

  it("at the same minute of an hour that is not a 6-hourly one, none of the three jobs run", async () => {
    await seedSprint();
    const old = new Date(NOT_SIX - 100 * 24 * 60 * 60 * 1000).toISOString();
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: old });
    await handleRepoCron(ghEnv(), NOT_SIX, okFetch);
    // Prune did not run — the old ping is still there.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up' AND at = ?`, old)).length).toBe(1);
    // Neither the reconcile nor the progress backstop ran.
    expect(await snapshots()).toHaveLength(0);
    expect(await progressRows()).toHaveLength(0);
  });
});
