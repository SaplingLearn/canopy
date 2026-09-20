import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { repoEnvironments } from "../src/repo/config";
import { putSnapshot, getSnapshot, putMetric, metricSeries, latestMetric, pruneRepoCapture } from "../src/repo/store";
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

  it("a metric point is unique per (metric, env, part, at)", async () => {
    const m = { metric: "health_ms", env: "staging", part: "backend", value: 212, at: "2026-09-20T10:00:00Z" };
    await putMetric(env.DB, m);
    await putMetric(env.DB, { ...m, value: 999 }); // a double-fired cron: first write stands
    await putMetric(env.DB, { ...m, at: "2026-09-20T10:10:00Z", value: 148 });
    expect(await metricSeries(env.DB, "health_ms", "staging", "backend", "2026-09-20T00:00:00Z"))
      .toEqual([{ at: "2026-09-20T10:00:00Z", value: 212 }, { at: "2026-09-20T10:10:00Z", value: 148 }]);
    expect(await latestMetric(env.DB, "health_ms", "staging", "backend")).toEqual({ at: "2026-09-20T10:10:00Z", value: 148 });
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
});
