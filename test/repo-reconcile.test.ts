import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { reconcileRepo } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import type { RepoEventRow } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");

/** A fake api.github.com keyed by path prefix. */
function fakeGithub(routes: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return hit ? new Response(JSON.stringify(routes[hit]), { status: 200 }) : new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const openPr = { number: 482, title: "Batch D1 reads", html_url: "https://github.com/o/r/pull/482", state: "open", draft: false, merged_at: null, updated_at: "2026-09-20T09:10:00Z", user: { login: "lpcooper-arch" }, head: { ref: "feature/usage-rollup", sha: "c91d2ae" }, base: { ref: "main" } };
const commit = { sha: "f00d", commit: { message: "old work\n\nbody", committer: { date: "2026-09-10T08:00:00Z" } }, author: { login: "AndresL230" } };

describe("reconcileRepo — deployments, workflow runs and env-head checks", () => {
  it("backfills Railway deployments with their statuses, recent runs, and env-head checks", async () => {
    const gh = fakeGithub({
      "/deployments?": [{ id: 7001, sha: "becdbac", ref: "becdbac", environment: "Sapling / staging", created_at: "2026-09-20T09:04:47Z", creator: { login: "railway-app[bot]" } }],
      "/deployments/7001/statuses": [{ id: 2, state: "success", created_at: "2026-09-20T09:05:34Z", log_url: "https://railway.com/l" }, { id: 1, state: "in_progress", created_at: "2026-09-20T09:04:47Z", log_url: null }],
      "/actions/runs?": { workflow_runs: [{ id: 99, name: "CI", head_branch: "main", head_sha: "becdbac", status: "completed", conclusion: "success", run_attempt: 1, event: "push", html_url: "https://github.com/o/r/actions/runs/99", updated_at: "2026-09-20T09:10:00Z", run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" } }] },
      "/commits/main/check-runs": { check_runs: [{ id: 5001, name: "Workers Builds: frontend-staging", status: "completed", conclusion: "success", head_sha: "becdbac", details_url: "https://dash", started_at: "2026-09-20T09:05:00Z", completed_at: "2026-09-20T09:06:32Z", app: { slug: "cloudflare-workers-and-pages" }, check_suite: { head_branch: "main" } }] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const kinds = await all<{ kind: string; n: number }>(env.DB, `SELECT kind, COUNT(*) AS n FROM repo_events GROUP BY kind ORDER BY kind`);
    expect(kinds).toEqual([{ kind: "check", n: 1 }, { kind: "deploy", n: 2 }, { kind: "run", n: 1 }]);
    // The check-runs list omits check_suite.head_branch reliably only per-ref: the branch we ASKED for is the branch.
    expect(await all(env.DB, `SELECT env, part FROM repo_events WHERE kind = 'check'`)).toEqual([{ env: "staging", part: "frontend" }]);
  });

  it("backfills each configured environment branch's head commit as a push row, even one pushed rarely", async () => {
    const gh = fakeGithub({
      "/commits?sha=production&per_page=1": [{ sha: "prodhead1234567", commit: { message: "release cut", committer: { date: "2026-09-19T10:00:00Z" } }, author: { login: "AndresL230" } }],
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const rows = await all(env.DB, `SELECT ref, sha, provenance FROM repo_events WHERE kind = 'push' AND ref = 'production'`);
    expect(rows).toEqual([{ ref: "production", sha: "prodhead1234567", provenance: "backfill" }]);
  });

  it("enriches a backfilled failing or timed-out run with its failing job title, capped at 5 lookups", async () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({
      id: 9000 + i, name: `CI ${i}`, head_branch: "main", head_sha: `sha${i}`, status: "completed",
      conclusion: i % 2 === 0 ? "failure" : "timed_out", run_attempt: 1, event: "push",
      html_url: `https://github.com/o/r/actions/runs/${9000 + i}`, updated_at: "2026-09-20T09:10:00Z",
      run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" },
    }));
    const gh = fakeGithub({
      "/actions/runs?": { workflow_runs: runs },
      "/jobs": { jobs: [{ name: "e2e", conclusion: "failure", steps: [{ name: "run suite", conclusion: "failure" }] }] },
    });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const jobCalls = gh.calls.filter((c) => c.includes("/jobs"));
    expect(jobCalls.length).toBe(5);
    const titled = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM repo_events WHERE kind = 'run' AND title IS NOT NULL`);
    expect(titled[0].n).toBe(5);
  });
});

describe("reconcileRepo", () => {
  it("backfills open PRs and older commits through the gate, idempotently", async () => {
    // Keyed to the pre-capture WINDOW call specifically (`&since=`) so it does not
    // also answer the per-environment-head commit fetch (`&per_page=1`, no `since`)
    // added for the env-head push backfill — those are separate, unmocked here.
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?sha=main&since=": [commit] });
    const first = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(first).toEqual({ written: 2, unchanged: 0 });
    const again = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(again).toEqual({ written: 0, unchanged: 2 });

    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events ORDER BY kind`);
    expect(rows.map((r) => [r.kind, r.provenance])).toEqual([["pr", "backfill"], ["push", "backfill"]]);
    expect(rows[0]).toMatchObject({ number: 482, state: "review", ref: "feature/usage-rollup" });
    expect(rows[1]).toMatchObject({ ref: "main", sha: "f00d", count: 1, title: "old work", actor_login: "AndresL230" });
  });

  it("sends the service token and never throws on a failing list", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    await expect(reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW)).resolves.toEqual({ written: 0, unchanged: 0 });
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
    }
  });
});

// F1: the `prs_reconciled` completeness marker. `prCaptured` in
// src/tools/repo.ts gates on this snapshot, not on "any pr row exists" — a
// lone webhook delivery must not make the Overview claim a complete open-PR
// count.
describe("reconcileRepo — the prs_reconciled completeness marker", () => {
  it("writes the marker once the open-PR list is fetched and ingested without throwing", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?": [] });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    const marker = await getSnapshot<{ at: string }>(env.DB, "prs_reconciled");
    expect(marker).not.toBeNull();
    expect(marker!.data.at).toBe(new Date(NOW).toISOString());
  });

  it("writes the marker even for a repo with zero open PRs — a marker, not a backfill row, earns it", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [], "/pulls?state=closed": [], "/commits?": [] });
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(await getSnapshot(env.DB, "prs_reconciled")).not.toBeNull();
  });

  it("does NOT write the marker when the open-PR fetch itself fails", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/pulls?state=open") ? new Response("nope", { status: 500 }) : new Response("[]", { status: 200 });
    }) as typeof fetch;
    await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    expect(await getSnapshot(env.DB, "prs_reconciled")).toBeNull();
  });
});
