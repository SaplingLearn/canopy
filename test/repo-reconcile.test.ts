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

describe("reconcileRepo", () => {
  it("backfills open PRs and older commits through the gate, idempotently", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?": [commit] });
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
