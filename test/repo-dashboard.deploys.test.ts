/**
 * Task 9 — two deployables per environment.
 *
 * The Repo dashboard projects the `deploy` / `check` / `run` / `review` capture
 * (Task 7) into environment cards with a Railway BACKEND half and a Cloudflare
 * FRONTEND half, deploy-history dots per half, "CI on head", and the CI-failure
 * list with its 7-day rate. Still D1-only: nothing here fetches.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import type { RepoEvent } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(env.DB, r); };
const base = { raw: "{}", provenance: "webhook" as const };
const deploy = (id: number, state: string, sha: string, mins: number, envKey = "staging"): RepoEvent =>
  ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: envKey, part: "backend", sha, state, actor_login: "railway-app[bot]", occurred_at: at(mins) });
const check = (id: number, name: string, state: string, sha: string, mins: number, over: Partial<RepoEvent> = {}): RepoEvent =>
  ({ ...base, semantic_key: `gh:check:${id}:${state === "pending" ? "created" : "completed"}`, kind: "check", number: id, name, state, sha, ref: "main", occurred_at: at(mins), ...over });
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };

describe("environment cards", () => {
  it("not_connected until an environment is configured AND something deployed", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments.status).toBe("not_connected");
  });

  it("shows both deployables, resolves the bot to the pusher, and summarises head checks", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      deploy(1, "in_progress", "abc", 28), deploy(1, "success", "abc", 26),
      check(10, "Workers Builds: frontend-staging", "success", "abc", 25, { env: "staging", part: "frontend" }),
      check(11, "Backend (pytest)", "success", "abc", 24),
      check(12, "e2e", "failure", "abc", 20),
    ]);
    const [staging, production] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ key: "staging", name: "staging", note: "main", pill: "DEGRADED", tone: "warn", ci: "1 of 3 checks failing — e2e", ciTone: "bad", url: "https://staging.saplinglearn.com" });
    expect(staging.parts).toEqual([
      { part: "backend", host: "Railway", sha: "abc", deployedAt: at(26), deployedBy: "AndresL230", result: "ok" },
      { part: "frontend", host: "Cloudflare", sha: "abc", deployedAt: at(25), deployedBy: "AndresL230", result: "ok" },
    ]);
    // Production has no capture yet: the card exists, honestly empty.
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(production.parts.map((p) => p.sha)).toEqual([null, null]);
  });

  it("a superseded deploy (success → inactive) still counts as deployed; a never-succeeded one is cancelled", async () => {
    await put([deploy(1, "success", "a", 300), deploy(1, "inactive", "a", 200), deploy(2, "in_progress", "b", 190), deploy(2, "inactive", "b", 180), deploy(3, "failure", "c", 100), deploy(4, "success", "d", 10)]);
    const rows = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).deploys);
    const backend = rows.find((r) => r.env === "staging" && r.part === "backend")!;
    expect(backend.label).toBe("staging · api");
    expect(backend.deploys.map((d) => [d.sha, d.result])).toEqual([["a", "ok"], ["b", "cancel"], ["c", "fail"], ["d", "ok"]]);
    // Nothing pushed those shas, so the deploy's own actor (the bot) is all there is.
    expect(backend.deploys[0].by).toBe("railway-app[bot]");
    // Only the environments that captured something get a row.
    expect(rows.map((r) => `${r.env}:${r.part}`)).toEqual(["staging:backend"]);
  });

  it("a deploy still in flight is not a dot, and leaves the card UNKNOWN", async () => {
    await put([deploy(9, "in_progress", "z", 5)]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(d.environments.status).toBe("not_connected");
    expect(d.deploys.status).toBe("not_connected");
  });

  it("the deploy feed and the env card read the same history", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abcdef1234", actor_login: "AndresL230", count: 1, occurred_at: at(40) },
      deploy(1, "success", "abcdef1234", 30),
    ]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const [staging] = ok(d.environments);
    expect(staging.parts[0]).toMatchObject({ sha: "abcdef1", deployedBy: "AndresL230" });
    expect(ok(d.activity).map((a) => [a.kind, a.text])).toContainEqual(["deploy", "abcdef1 deployed to staging · api"]);
  });
});

describe("CI failures", () => {
  const run = (id: number, state: string, mins: number, title: string | null = null): RepoEvent =>
    ({ ...base, semantic_key: `gh:run:${id}:1`, kind: "run", number: id, name: "e2e (browser lane)", ref: "main", sha: "abc", state, title, url: `https://github.com/o/r/actions/runs/${id}`, occurred_at: at(mins) });

  it("lists failed runs with their job, and a 7-day rate over decisive runs only", async () => {
    await put([run(1, "success", 500), run(2, "success", 400), run(3, "failure", 60, "e2e · Run supabase/setup-cli@v1"), run(4, "cancelled", 30), run(5, "success", 20)]);
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
    expect(f.rate).toBe(25);                     // 1 failure / 4 decisive (cancelled excluded)
    expect(f.trend).toHaveLength(7);
    expect(f.rows).toEqual([{ workflow: "e2e (browser lane)", branch: "main", job: "e2e · Run supabase/setup-cli@v1", at: at(60), url: "https://github.com/o/r/actions/runs/3" }]);
  });

  it("is not_connected until a workflow run has ever been captured", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures.status).toBe("not_connected");
  });
});

describe("reviews", () => {
  const review = (id: number, number: number, state: string, actor: string, mins: number): RepoEvent =>
    ({ ...base, semantic_key: `gh:review:${id}:submitted`, kind: "review", number, state, actor_login: actor, url: `https://github.com/o/r/pull/${number}#r${id}`, occurred_at: at(mins) });

  it("counts this week's reviews per person and puts them in the feed", async () => {
    await put([review(1, 7, "approved", "AndresL230", 30), review(2, 7, "commented", "meilin", 60)]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(ok(d.contributors).map((c) => [c.person.login, c.reviews])).toEqual([["AndresL230", 1], ["meilin", 1]]);
    expect(ok(d.activity).map((a) => [a.kind, a.text])).toEqual([["review", "approved #7"], ["review", "commented on #7"]]);
  });
});
