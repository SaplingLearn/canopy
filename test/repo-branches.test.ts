import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { refreshBranches } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import type { RepoBranches } from "@shared/repo";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const node = (name: string, date: string, aheadBy: number, behindBy: number) => ({ name, target: { committedDate: date }, compare: { aheadBy, behindBy } });

describe("refreshBranches", () => {
  it("pages refs over ghGraphql, inverts compare, flags stale, and leaves the environment branches out", async () => {
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node("main", "2026-09-20T09:00:00Z", 0, 0), node("feature/usage-rollup", "2026-09-20T11:36:00Z", 0, 4)] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("spike/edge-cache", "2026-09-04T00:00:00Z", 31, 7), node("production", "2026-09-18T00:00:00Z", 5, 1)] },
    ];
    let call = 0;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.github.com/graphql");
      expect(JSON.parse(String(init?.body)).variables).toMatchObject({ owner: "o", name: "r", head: "main" });
      return new Response(JSON.stringify({ data: { repository: { refs: pages[call++] } } }), { status: 200 });
    }) as typeof fetch;

    await refreshBranches(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    const snap = (await getSnapshot<RepoBranches>(env.DB, "branches"))!.data;
    expect(snap).toMatchObject({ active: 1, stale: 1 });
    expect(snap.rows).toEqual([
      { name: "feature/usage-rollup", at: "2026-09-20T11:36:00Z", ahead: 4, behind: 0, stale: false },
      { name: "spike/edge-cache", at: "2026-09-04T00:00:00Z", ahead: 7, behind: 31, stale: true },
    ]);
  });

  it("keeps the previous snapshot when the refs query fails, and never throws", async () => {
    await refreshBranches(env.DB, { token: "t", repo: "o/r", fetchImpl: (async () => new Response(JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("feature/x", "2026-09-19T00:00:00Z", 0, 1)] } } } }), { status: 200 })) as typeof fetch }, ENVS, NOW);
    const before = await getSnapshot<RepoBranches>(env.DB, "branches");
    expect(before).not.toBeNull();

    const fetchImpl = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(refreshBranches(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW)).resolves.toBeUndefined();
    const after = await getSnapshot<RepoBranches>(env.DB, "branches");
    expect(after).toEqual(before);
  });
});
