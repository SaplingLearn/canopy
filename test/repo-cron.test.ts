/**
 * Task 13 — health pings and the 10-minute cron trigger.
 *
 * `pingHealth` writes the health_up/health_ms metrics one 10-minute bucket at a
 * time; `handleRepoCron` is the single repo cron trigger's dispatcher — health
 * on every tick, and (every 6th hour) the progress backstop, the GitHub
 * reconcile, and the capture prune.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pingHealth } from "../src/repo/poll";
import { handleRepoCron, REPO_CRON } from "../src/repo/cron";
import { getRepoDashboard } from "../src/tools/repo";
import { getSnapshot, putMetric } from "../src/repo/store";
import { ENVS, fakeGithub } from "./helpers/repo";
import type { Env } from "../src/env";

const T = Date.parse("2026-09-20T12:07:31Z");
const SIX_HOURLY = Date.parse("2026-09-20T12:00:00Z");
const HOURLY_NOT_SIX = Date.parse("2026-09-20T13:00:00Z");

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

  it("feeds the health block and drags the pill to DEGRADED when a target is down", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    const d = await getRepoDashboard(env.DB, "o/r", T, ENVS);
    expect(d.health.status).toBe("ok");
    const rows = (d.health as { data: { env: string; up: boolean }[] }).data;
    expect(rows.map((r) => [r.env, r.up])).toEqual([["staging · web", true], ["staging · api", false], ["production · web", true], ["production · api", true]]);
  });

  it("a health row older than 30 minutes is stale — treated as absent, not shown", async () => {
    const stale = T - 31 * 60_000;
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: new Date(stale).toISOString() });
    await putMetric(env.DB, { metric: "health_ms", env: "staging", part: "frontend", value: 100, at: new Date(stale).toISOString() });
    const d = await getRepoDashboard(env.DB, "o/r", T, ENVS);
    expect(d.health.status).toBe("not_connected");
  });
});

describe("handleRepoCron", () => {
  it("is the cron expression wrangler.toml declares", () => expect(REPO_CRON).toBe("*/10 * * * *"));

  it("pings every tick; with no service token it does nothing else and never throws", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await handleRepoCron({ ...env, GITHUB_SERVICE_TOKEN: undefined } as unknown as Env, T, fetchImpl);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect((await all(env.DB, `SELECT 1 FROM repo_snapshots`)).length).toBe(0);
  });

  it("at a 6-hourly tick with a service token, reconciles through the injected fetch and leaves its snapshots", async () => {
    const gh = fakeGithub({
      "/pulls?state=open": [], "/pulls?state=closed": [],
      "/commits?sha=main&per_page=1": [{ sha: "mainhead0000001", commit: { message: "ship it", committer: { date: "2026-09-20T10:00:00Z" } }, author: { login: "AndresL230" } }],
      "/commits?sha=production&per_page=1": [{ sha: "prodhead1234567", commit: { message: "release cut", committer: { date: "2026-09-19T10:00:00Z" } }, author: { login: "AndresL230" } }],
    });
    await handleRepoCron({ ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r" } as unknown as Env, SIX_HOURLY, gh.fetchImpl);
    // The end-to-end cover the admin route can never have (it has no fetchImpl seam).
    expect(await getSnapshot(env.DB, "prs_reconciled")).not.toBeNull();
    expect(await getSnapshot(env.DB, "env_heads")).not.toBeNull();
    expect(await getSnapshot(env.DB, "drift")).not.toBeNull();
    expect(await getSnapshot(env.DB, "branches")).not.toBeNull();
    // Health still pinged on the same tick.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
  });

  it("at a 6-hourly tick with no service token, only health runs and no snapshot is written", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await handleRepoCron({ ...env, GITHUB_SERVICE_TOKEN: undefined } as unknown as Env, SIX_HOURLY, fetchImpl);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect((await all(env.DB, `SELECT 1 FROM repo_snapshots`)).length).toBe(0);
  });

  it("at an hourly-but-not-6-hourly tick, neither the reconcile nor the prune runs", async () => {
    const old = new Date(HOURLY_NOT_SIX - 100 * 24 * 60 * 60 * 1000).toISOString(); // well past the 45-day retention
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: old });
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await handleRepoCron({ ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r" } as unknown as Env, HOURLY_NOT_SIX, fetchImpl);
    // Prune did not run — the old ping is still there.
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up' AND at = ?`, old)).length).toBe(1);
    // Reconcile did not run — no snapshot exists.
    expect((await all(env.DB, `SELECT 1 FROM repo_snapshots`)).length).toBe(0);
  });
});
