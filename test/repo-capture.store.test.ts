import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { repoEnvironments } from "../src/repo/config";
import { putSnapshot, getSnapshot, putMetric, metricSeries, metricsSince, metricsEver, latestMetric, pruneRepoCapture } from "../src/repo/store";
import type { RepoEvent, RepoEventRow } from "../src/repo/types";

const push = (over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: "gh:push:abc1234:main", kind: "push", ref: "main", sha: "abc1234", actor_login: "jose-a",
  count: 2, title: "fix: thing", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T10:00:00Z", ...over,
});

describe("ingestRepoEvent — the repo capture gate", () => {
  it("writes once and drops a redelivery as unchanged", async () => {
    expect((await ingestRepoEvent(env.DB, push())).outcome).toBe("written");
    expect((await ingestRepoEvent(env.DB, push())).outcome).toBe("unchanged");
    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "push", ref: "main", sha: "abc1234", count: 2, env: null, part: null });
  });

  it("never raises an identity task — bots and CI are not people", async () => {
    await ingestRepoEvent(env.DB, push({ actor_login: "railway-app[bot]" }));
    expect(await all(env.DB, `SELECT * FROM identity_tasks`)).toHaveLength(0);
  });
});

describe("repoEnvironments", () => {
  it("parses the configured environments and tolerates junk", () => {
    const envs = repoEnvironments(env);
    expect(envs.map((e) => [e.key, e.branch])).toEqual([["staging", "main"], ["production", "production"]]);
    expect(repoEnvironments({ REPO_ENVIRONMENTS: "not json" })).toEqual([]);
    expect(repoEnvironments({})).toEqual([]);
  });
});

describe("snapshots and metrics", () => {
  it("a snapshot is last-write-wins", async () => {
    await putSnapshot(env.DB, "drift", { ahead: 1 }, "2026-09-20T10:00:00Z");
    await putSnapshot(env.DB, "drift", { ahead: 5 }, "2026-09-20T11:00:00Z");
    expect(await getSnapshot<{ ahead: number }>(env.DB, "drift")).toEqual({ data: { ahead: 5 }, computedAt: "2026-09-20T11:00:00Z" });
    expect(await getSnapshot(env.DB, "nope")).toBeNull();
  });

  // M9: `at` is compared as a RAW STRING by every read (`ORDER BY at`,
  // `at >= ?`), so the write seam normalises it — one `toISOString()` shape for
  // every writer, present and future.
  it("a metric point is unique per (metric, env, part, at), stored in one normalised format", async () => {
    const m = { metric: "health_ms", env: "staging", part: "backend", value: 212, at: "2026-09-20T10:00:00Z" };
    await putMetric(env.DB, m);
    await putMetric(env.DB, { ...m, value: 999 }); // a double-fired cron: first write stands
    await putMetric(env.DB, { ...m, at: "2026-09-20T10:10:00Z", value: 148 });
    expect(await metricSeries(env.DB, "health_ms", "staging", "backend", "2026-09-20T00:00:00Z"))
      .toEqual([{ at: "2026-09-20T10:00:00.000Z", value: 212 }, { at: "2026-09-20T10:10:00.000Z", value: 148 }]);
    expect(await latestMetric(env.DB, "health_ms", "staging", "backend")).toEqual({ at: "2026-09-20T10:10:00.000Z", value: 148 });
  });

  // M1 (Task 14): `metricSeries` compares `at >= sinceIso` as a raw string —
  // its FIRST production caller (the coverage/bundle/TODO reads) passes a
  // caller-computed bound that may lack milliseconds, which would otherwise
  // sort AFTER a normalised "…000Z" row of the same instant and wrongly
  // exclude it.
  it("normalises its `sinceIso` bound the same way `at` is stored, and returns [] for an unparseable one", async () => {
    await putMetric(env.DB, { metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T09:30:00Z" });
    // Bound given WITHOUT milliseconds — the point above is stored WITH them
    // ("2026-09-20T09:30:00.000Z"). A raw-string compare would exclude it.
    expect(await metricSeries(env.DB, "coverage", "", "", "2026-09-20T09:30:00Z"))
      .toEqual([{ at: "2026-09-20T09:30:00.000Z", value: 78.4 }]);
    expect(await metricSeries(env.DB, "coverage", "", "", "not a date")).toEqual([]);
  });

  // Task 16: the Usage tab reads every usage series of every environment in ONE
  // statement and slices the ranges in memory.
  it("metricsSince returns several metrics across envs in one ordered read, bound normalised like metricSeries", async () => {
    await putMetric(env.DB, { metric: "cf_requests", env: "production", part: "frontend", value: 9, at: "2026-09-20T11:00:00Z" });
    await putMetric(env.DB, { metric: "cf_requests", env: "staging", part: "frontend", value: 5, at: "2026-09-20T09:00:00Z" });
    await putMetric(env.DB, { metric: "cf_errors", env: "staging", part: "frontend", value: 1, at: "2026-09-20T10:00:00Z" });
    await putMetric(env.DB, { metric: "cf_requests", env: "staging", part: "frontend", value: 4, at: "2026-09-20T08:00:00Z" }); // before the bound
    await putMetric(env.DB, { metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T10:30:00Z" });                  // not asked for
    // Bound WITHOUT milliseconds, equal to a stored instant — a raw compare would drop it.
    expect(await metricsSince(env.DB, ["cf_requests", "cf_errors"], "2026-09-20T09:00:00Z")).toEqual([
      { metric: "cf_requests", env: "staging", part: "frontend", at: "2026-09-20T09:00:00.000Z", value: 5 },
      { metric: "cf_errors", env: "staging", part: "frontend", at: "2026-09-20T10:00:00.000Z", value: 1 },
      { metric: "cf_requests", env: "production", part: "frontend", at: "2026-09-20T11:00:00.000Z", value: 9 },
    ]);
    expect(await metricsSince(env.DB, ["cf_requests"], "not a date")).toEqual([]);
    expect(await metricsSince(env.DB, [], "2026-09-20T09:00:00Z")).toEqual([]);
  });

  it("metricsEver names which of the asked metrics have EVER landed, whatever their age or env", async () => {
    expect(await metricsEver(env.DB, ["cf_requests", "active_users_7d"])).toEqual(new Set());
    await putMetric(env.DB, { metric: "cf_requests", env: "staging", part: "frontend", value: 5, at: "2020-01-01T00:00:00Z" });
    expect(await metricsEver(env.DB, ["cf_requests", "active_users_7d"])).toEqual(new Set(["cf_requests"]));
    expect(await metricsEver(env.DB, [])).toEqual(new Set());
  });

  it("the same instant written in two formats is ONE row, and an unparseable `at` is skipped", async () => {
    const m = { metric: "health_up", env: "staging", part: "backend", value: 1 };
    await putMetric(env.DB, { ...m, at: "2026-09-20T10:00:00Z" });
    await putMetric(env.DB, { ...m, at: "2026-09-20T10:00:00.000Z" });
    await putMetric(env.DB, { ...m, at: "2026-09-20T12:00:00+02:00" }); // the same instant again
    await putMetric(env.DB, { ...m, at: "not a date" });
    expect(await all<{ at: string }>(env.DB, `SELECT at FROM repo_metrics`)).toEqual([{ at: "2026-09-20T10:00:00.000Z" }]);
  });

  it("prune drops old pings and check runs, keeps slow metrics and deploys", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const old = "2026-07-01T00:00:00Z";
    await putMetric(env.DB, { metric: "health_ms", env: "staging", part: "backend", value: 1, at: old });
    await putMetric(env.DB, { metric: "coverage", env: "", part: "", value: 78.4, at: old });
    await ingestRepoEvent(env.DB, push({ semantic_key: "k1", kind: "check", occurred_at: old }));
    await ingestRepoEvent(env.DB, push({ semantic_key: "k2", kind: "deploy", occurred_at: old }));
    await pruneRepoCapture(env.DB, now);
    expect((await all<{ metric: string }>(env.DB, `SELECT metric FROM repo_metrics`)).map((r) => r.metric)).toEqual(["coverage"]);
    expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_events`)).map((r) => r.kind)).toEqual(["deploy"]);
  });

  // P2 (Task 13 parked finding): a FRONTEND DEPLOY is a `check` row carrying
  // `part = 'frontend'` (a Workers Builds check run), while backend deploys are
  // `deploy` rows kept forever. Pruning every old `check` row regardless of
  // `part` would age out the frontend dot strip asymmetrically — only a
  // `part IS NULL` (a plain CI check, not a deploy record) may be pruned.
  it("keeps an old frontend-deploy check row (part='frontend'), prunes a plain CI check (part=null)", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const old = "2026-07-01T00:00:00Z";
    await ingestRepoEvent(env.DB, push({ semantic_key: "plain-ci", kind: "check", part: null, occurred_at: old }));
    await ingestRepoEvent(env.DB, push({ semantic_key: "frontend-deploy", kind: "check", env: "staging", part: "frontend", occurred_at: old }));
    await pruneRepoCapture(env.DB, now);
    const kept = await all<{ semantic_key: string }>(env.DB, `SELECT semantic_key FROM repo_events`);
    expect(kept.map((r) => r.semantic_key)).toEqual(["frontend-deploy"]);
  });

  // Task 16: hourly usage series (Cloudflare analytics, later Railway and the
  // active-user gauges) are read over 30 days at most — 100 days is ample, and
  // without a bound two environments add ~35,000 rows a year.
  it("prunes hourly usage metrics past 100 days, keeps younger ones and never touches a slow metric", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    for (const metric of ["cf_requests", "cf_errors", "rw_cpu", "active_users_7d"]) {
      await putMetric(env.DB, { metric, env: "staging", part: "frontend", value: 1, at: daysAgo(101) });
      await putMetric(env.DB, { metric, env: "staging", part: "frontend", value: 2, at: daysAgo(99) });
    }
    await putMetric(env.DB, { metric: "coverage", env: "", part: "", value: 78.4, at: daysAgo(400) });
    // A metric that merely CONTAINS a usage prefix is not a usage metric.
    await putMetric(env.DB, { metric: "xcf_requests", env: "", part: "", value: 1, at: daysAgo(400) });
    // The 45-day rule is unchanged: a 60-day-old ping still goes, a 60-day-old usage point stays.
    await putMetric(env.DB, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: daysAgo(60) });
    await putMetric(env.DB, { metric: "cf_requests", env: "staging", part: "frontend", value: 3, at: daysAgo(60) });
    await pruneRepoCapture(env.DB, now);
    const kept = await all<{ metric: string; value: number }>(env.DB, `SELECT metric, value FROM repo_metrics ORDER BY metric, at`);
    expect(kept).toEqual([
      { metric: "active_users_7d", value: 2 }, { metric: "cf_errors", value: 2 },
      { metric: "cf_requests", value: 2 }, { metric: "cf_requests", value: 3 },
      { metric: "coverage", value: 78.4 }, { metric: "rw_cpu", value: 2 }, { metric: "xcf_requests", value: 1 },
    ]);
  });
});
