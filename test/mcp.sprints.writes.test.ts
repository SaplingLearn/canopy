import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { first } from "../src/db";
import { create_sprint } from "../src/tools/sprints";
import { SprintCreate, type SprintDetail, type SprintView } from "@shared/sprints";
import type { SprintRow } from "@shared/rows";
import { seedPerson } from "./helpers/persons";

// Phase 3: the FOUR admin-only sprint write tools, driven through the REAL
// registered closures. ADMIN_LOGINS binds only "admin-user" (vitest.config.ts).
//
// Conditional registration means a non-admin does not merely get refused — the
// tools are absent from tools/list entirely, exactly like update_plan.

const ADMIN = "admin-user";
const ADMIN_WRITE_TOOLS = ["create_sprint", "set_sprint_active", "complete_sprint", "add_sprint_resource"] as const;

async function withClient<T>(handle: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildCanopyMcpServer(env as unknown as Env, { handle });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callTool(handle: string, name: string, args: Record<string, unknown> = {}) {
  return withClient(handle, async (client) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}

function ok<T>(r: { text: string; isError?: boolean }): T {
  expect(r.isError, r.text).toBeFalsy();
  return JSON.parse(r.text) as T;
}
function failed(r: { text: string; isError?: boolean }) {
  expect(r.isError, `expected a refusal, got: ${r.text}`).toBe(true);
  return JSON.parse(r.text) as { error: string; code?: string };
}

const seedSprint = (label: string, due = "2026-09-01") =>
  create_sprint(env.DB, SprintCreate.parse({ label, due }), ADMIN);

describe("the sprint write surface is admin-gated", () => {
  it("registers all four for an admin", async () => {
    await seedPerson(ADMIN);
    const names = await withClient(ADMIN, async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const t of ADMIN_WRITE_TOOLS) expect(names).toContain(t);
  });

  it("hides all four from a non-admin — absent, not merely refused", async () => {
    await seedPerson("andres");
    const names = await withClient("andres", async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const t of ADMIN_WRITE_TOOLS) expect(names).not.toContain(t);
    // A fresh server is built per request with the principal in scope, so calling
    // one by name is tool-not-found rather than a permission error — the same
    // shape update_plan already has for a non-admin.
    for (const t of ADMIN_WRITE_TOOLS) {
      const res = await callTool("andres", t, { id: 1, label: "sneaky", active: true, raw: "#1" });
      expect(res.isError, t).toBeTruthy();
      expect(res.text.toLowerCase(), t).toContain("not found");
    }
  });

  it("is admin-only even for complete_sprint, which the WEB lets any member do", async () => {
    // POST /sprints/:id/complete sits under sessionGate with no adminGate. Over MCP
    // it is admin-only. The delta is deliberate — assert BOTH halves so a later
    // reader cannot mistake it for an oversight.
    await seedPerson("beatrix");
    const names = await withClient("beatrix", async (c) => (await c.listTools()).tools.map((t) => t.name));
    expect(names).not.toContain("complete_sprint");
  });
});

describe("create_sprint", () => {
  it("lands inactive and unscheduled when no due date is given", async () => {
    await seedPerson(ADMIN);
    const sp = ok<SprintView>(await callTool(ADMIN, "create_sprint", { label: "Q4 notifications" }));
    expect(sp.label).toBe("Q4 notifications");
    expect(sp.status).toBe("upcoming");
    expect(sp.active).toBe(false);
    expect(sp.phase).toBe("Unscheduled");
    // target_date is NOT NULL, so '' is stored and the DTO surfaces it as null.
    expect(sp.due).toBeNull();
  });

  it("speaks the DTO vocabulary, and the columns follow", async () => {
    await seedPerson(ADMIN);
    const sp = ok<SprintView>(await callTool(ADMIN, "create_sprint", {
      label: "Search polish", due: "2026-11-01", summary: "bm25 tuning", urgency: "high", lead: ADMIN, domain: "search",
    }));
    expect(sp.due).toBe("2026-11-01");
    expect(sp.urgency).toBe("high");
    expect(sp.domain).toBe("search");
    // row.title ↔ view.label, row.target_date ↔ view.due — the seam holds.
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, sp.id);
    expect(row!.title).toBe("Search polish");
    expect(row!.target_date).toBe("2026-11-01");
  });
});

describe("set_sprint_active", () => {
  it("maps true → in_progress and false → upcoming", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Queue cleanup");
    const on = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(on.status).toBe("in_progress");
    expect(on.active).toBe(true);
    const off = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: false }));
    expect(off.status).toBe("upcoming");
    expect(off.active).toBe(false);
  });

  it("clearing active on a DONE sprint is a no-op; setting it re-opens", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Finished work");
    ok(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));

    // false must never un-finish a sprint.
    const noop = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: false }));
    expect(noop.status).toBe("done");
    // true re-opens one that turned out not to be finished.
    const reopened = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(reopened.status).toBe("in_progress");
  });
});

describe("complete_sprint", () => {
  it("flips a live sprint to done", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Shipped");
    const done = ok<SprintRow>(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    expect(done.status).toBe("done");
    expect((await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, seeded.id))!.status).toBe("done");
  });

  it("two concurrent completions: exactly one wins, the other conflicts", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Contested");

    // The guard is in the UPDATE's WHERE, not a prior read, so the loser cannot
    // slip through the window between a status check and the write. Without that,
    // both callers report success for the one sprint.
    const [a, b] = await Promise.all([
      callTool(ADMIN, "complete_sprint", { id: seeded.id }),
      callTool(ADMIN, "complete_sprint", { id: seeded.id }),
    ]);
    const outcomes = [a, b].map((r) => (r.isError ? "conflict" : "ok"));
    expect(outcomes.sort()).toEqual(["conflict", "ok"]);

    const loser = [a, b].find((r) => r.isError)!;
    expect(failed(loser).code).toBe("conflict");
    // …and the sprint is done exactly once, whichever call won.
    expect((await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, seeded.id))!.status).toBe("done");
  });

  it("answers in the DTO vocabulary, like its three neighbours", async () => {
    // The seam (shared/sprints.ts): the DB keeps its column names, every DTO
    // speaks the product's words. An agent is told to read the new state back
    // off the write response, so a writer that answers with a raw row hands it
    // `label: undefined` and no `active` at all — and this is the one tool of
    // the four that used to. Asserted against a sibling so the two cannot drift.
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Speaks the DTO");
    const done = ok<SprintView>(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));

    expect(done.label).toBe("Speaks the DTO");
    expect(done.due).toBe("2026-09-01");
    expect(done.status).toBe("done");
    expect(done.active).toBe(false);
    expect(done).not.toHaveProperty("title");
    expect(done).not.toHaveProperty("target_date");

    const reopened = ok<SprintView>(await callTool(ADMIN, "set_sprint_active", { id: seeded.id, active: true }));
    expect(Object.keys(done).sort()).toEqual(Object.keys(reopened).sort());
  });

  it("refuses an unknown sprint and a second completion, with TYPED codes", async () => {
    await seedPerson(ADMIN);
    // The two refusals are different answers for an agent — retry with a real id,
    // versus nothing left to do — so they must not both arrive as a bare message.
    const unknown = failed(await callTool(ADMIN, "complete_sprint", { id: 4242 }));
    expect(unknown.error).toMatch(/no such sprint/i);
    expect(unknown.code).toBe("not_found");

    const seeded = await seedSprint("Once");
    ok(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    const again = failed(await callTool(ADMIN, "complete_sprint", { id: seeded.id }));
    expect(again.error).toMatch(/already done/i);
    expect(again.code).toBe("conflict");
  });
});

describe("add_sprint_resource", () => {
  it("parses through the SHARED link parser and is idempotent on url", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("With resources");
    const one = ok<SprintDetail>(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "#214" }));
    expect(one.resources.map((r) => r.url)).toContain("https://github.com/SaplingLearn/sapling/issues/214");
    expect(one.resources.find((r) => r.url.endsWith("/214"))!.label).toBe("sapling #214");

    const twice = ok<SprintDetail>(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "214" }));
    expect(twice.resources.filter((r) => r.url.endsWith("/214"))).toHaveLength(1);
  });

  it("refuses an unusable link and an unknown sprint", async () => {
    await seedPerson(ADMIN);
    const seeded = await seedSprint("Strict");
    expect(failed(await callTool(ADMIN, "add_sprint_resource", { id: seeded.id, raw: "javascript:alert(1)" })).code).toBe("bad_request");
    expect(failed(await callTool(ADMIN, "add_sprint_resource", { id: 4242, raw: "#1" })).code).toBe("not_found");
  });
});
