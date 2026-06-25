import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import {
  route_triage,
  stage_adr,
  ratify_adr,
  stage_milestone_proposal,
  promote_milestone_proposal,
} from "../src/tools/writes";
import {
  list_needs_triage,
  list_adrs,
  list_milestone_proposals,
} from "../src/tools/reads";

async function authedCookie(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

// ---------------------------------------------------------------------------
// 2. list_needs_triage
// ---------------------------------------------------------------------------

describe("list_needs_triage", () => {
  it("returns only unresolved triage items", async () => {
    const id1 = await route_triage(env.DB, { raw: "item1", reason: "bad tag" });
    await route_triage(env.DB, { raw: "item2", reason: "low confidence" });
    // mark first one resolved
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id1).run();

    const items = await list_needs_triage(env.DB);
    expect(items.length).toBe(1);
    expect(items[0].raw).toBe("item2");
    expect(items[0].resolved).toBe(0);
  });

  it("returns empty array when all items are resolved", async () => {
    const id = await route_triage(env.DB, { raw: "item", reason: "test" });
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id).run();
    const items = await list_needs_triage(env.DB);
    expect(items).toHaveLength(0);
  });
});

describe("GET /needs-triage", () => {
  it("returns { items: [...] } with only unresolved items for an authenticated user", async () => {
    const id1 = await route_triage(env.DB, { raw: "alpha", reason: "out of vocab" });
    await route_triage(env.DB, { raw: "beta", reason: "low confidence" });
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id1).run();

    const cookie = await authedCookie("andres");
    const res = await app.request("/needs-triage", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ raw: string; resolved: number }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0].raw).toBe("beta");
    expect(body.items[0].resolved).toBe(0);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/needs-triage", {}, env);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. list_adrs
// ---------------------------------------------------------------------------

const adrBase = { title: "Use SQLite", context: "We need storage", decision: "SQLite", rationale: "Simple", confidence: "high" as const };

describe("list_adrs", () => {
  it("returns all adrs when no status filter", async () => {
    const id1 = await stage_adr(env.DB, adrBase, "andres");
    const id2 = await stage_adr(env.DB, { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(env.DB, id1);

    const adrs = await list_adrs(env.DB);
    expect(adrs.length).toBe(2);
  });

  it("filters by status=draft", async () => {
    const id1 = await stage_adr(env.DB, adrBase, "andres");
    await stage_adr(env.DB, { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(env.DB, id1);

    const drafts = await list_adrs(env.DB, "draft");
    expect(drafts.length).toBe(1);
    expect(drafts[0].status).toBe("draft");
    expect(drafts[0].title).toBe("Use Hono");
  });

  it("filters by status=ratified", async () => {
    const id1 = await stage_adr(env.DB, adrBase, "andres");
    await stage_adr(env.DB, { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(env.DB, id1);

    const ratified = await list_adrs(env.DB, "ratified");
    expect(ratified.length).toBe(1);
    expect(ratified[0].status).toBe("ratified");
  });
});

describe("GET /adrs", () => {
  it("returns { adrs: [...] } for all adrs when no filter", async () => {
    const id1 = await stage_adr(env.DB, adrBase, "andres");
    await stage_adr(env.DB, { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(env.DB, id1);

    const cookie = await authedCookie("andres");
    const res = await app.request("/adrs", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { adrs: Array<{ status: string }> };
    expect(body.adrs.length).toBe(2);
  });

  it("filters by ?status=draft", async () => {
    const id1 = await stage_adr(env.DB, adrBase, "andres");
    await stage_adr(env.DB, { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(env.DB, id1);

    const cookie = await authedCookie("andres");
    const res = await app.request("/adrs?status=draft", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { adrs: Array<{ status: string }> };
    expect(body.adrs.length).toBe(1);
    expect(body.adrs[0].status).toBe("draft");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/adrs", {}, env);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. list_milestone_proposals
// ---------------------------------------------------------------------------

const proposalBase = {
  title: "Launch v1",
  target_date: "2026-09-01",
  status: "upcoming",
  change_summary: "initial proposal",
  confidence: "high" as const,
};

describe("list_milestone_proposals", () => {
  it("returns only staged proposals", async () => {
    const id1 = await stage_milestone_proposal(env.DB, proposalBase, "andres");
    await stage_milestone_proposal(env.DB, { ...proposalBase, title: "Launch v2" }, "andres");
    // promote first one
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
    ).bind("andres", "andres", "2026-01-01T00:00:00Z").run();
    await promote_milestone_proposal(env.DB, id1, "andres");

    const proposals = await list_milestone_proposals(env.DB);
    expect(proposals.length).toBe(1);
    expect(proposals[0].title).toBe("Launch v2");
    expect(proposals[0].staged_status).toBe("staged");
  });

  it("returns empty when all proposals are promoted", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
    ).bind("andres", "andres", "2026-01-01T00:00:00Z").run();
    const id = await stage_milestone_proposal(env.DB, proposalBase, "andres");
    await promote_milestone_proposal(env.DB, id, "andres");
    const proposals = await list_milestone_proposals(env.DB);
    expect(proposals).toHaveLength(0);
  });
});

describe("GET /milestone-proposals", () => {
  it("returns { proposals: [...] } with only staged proposals", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
    ).bind("andres", "andres", "2026-01-01T00:00:00Z").run();
    const id1 = await stage_milestone_proposal(env.DB, proposalBase, "andres");
    await stage_milestone_proposal(env.DB, { ...proposalBase, title: "Launch v2" }, "andres");
    await promote_milestone_proposal(env.DB, id1, "andres");

    const cookie = await authedCookie("andres");
    const res = await app.request("/milestone-proposals", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { proposals: Array<{ title: string; staged_status: string }> };
    expect(body.proposals.length).toBe(1);
    expect(body.proposals[0].title).toBe("Launch v2");
    expect(body.proposals[0].staged_status).toBe("staged");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/milestone-proposals", {}, env);
    expect(res.status).toBe(401);
  });
});
