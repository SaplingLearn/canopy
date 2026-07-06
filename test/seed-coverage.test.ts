import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { getMyWork } from "../src/tools/mywork";
import { get_plan } from "../src/tools/plan";
import { query, get_feed, list_proposals, list_needs_triage, list_adrs, list_identity_tasks } from "../src/tools/reads";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import triage from "../fixtures/dev/triage.json";
import roadmap from "../fixtures/dev/roadmap.json";
import events from "../fixtures/dev/events.json";
import identity from "../fixtures/dev/identity.json";

const fx = { docs, feed, adrs, triage, roadmap, events, identity };

beforeEach(async () => {
  for (const stmt of buildSeedStatements(fx)) {
    await env.DB.prepare(stmt).run();
  }
});

describe("dev seed lights up every surface", () => {
  it("My Work: previous activity + to-dos for AndresL230", async () => {
    const mw = await getMyWork(env.DB, "AndresL230");
    expect(mw.degraded).toBe(false);
    expect(mw.person).toBe("Andres");
    expect(mw.previousActivity.length).toBeGreaterThan(0);
    expect(mw.todo.length).toBeGreaterThan(0);
    // Priority tag parsed + stripped from an assigned issue.
    expect(mw.todo.some((t) => t.priority === "P1")).toBe(true);
  });

  it("Roadmap: narrative + milestones carrying progress", async () => {
    const plan = await get_plan(env.DB);
    expect(plan.narrative.length).toBeGreaterThan(0);
    expect(plan.milestones.length).toBe(3);
    expect(plan.milestones.some((m) => m.progress && m.progress.total > 0)).toBe(true);
  });

  it("Search: ranked hits for a known term", async () => {
    const r = await query(env.DB, { q: "MCP", include_staged: true });
    expect(r.primary.length).toBeGreaterThan(0);
  });

  it("Feed: tagged entries present", async () => {
    expect((await get_feed(env.DB, {})).length).toBeGreaterThan(0);
    expect((await get_feed(env.DB, { tags: ["auth"] })).length).toBeGreaterThan(0);
  });

  it("Triage: all four queues populated", async () => {
    expect((await list_proposals(env.DB)).length).toBeGreaterThan(0);
    expect((await list_needs_triage(env.DB)).length).toBeGreaterThan(0);
    expect((await list_adrs(env.DB, "draft")).length).toBeGreaterThan(0);
    expect((await list_identity_tasks(env.DB)).length).toBeGreaterThan(0);
  });
});
