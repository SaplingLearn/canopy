import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run, nowIso } from "../src/db";
import type { SprintRow } from "@shared/rows";
import { fetchGithubRefProgress, upsertProgress } from "../src/tools/progress";
import { get_plan, write_plan } from "../src/tools/plan";
import { complete_sprint } from "../src/tools/writes";
import { app } from "../src/routes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { cookieFor } from "./helpers/persons";

/** Insert a sprint straight into D1 (the shape a pre-0025 milestone row had). */
async function seedSprint(title: string, status: SprintRow["status"], targetDate = "2026-09-01"): Promise<number> {
  const now = nowIso();
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, target_date, status, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, 'andres', ?)`,
    title,
    targetDate,
    status,
    now,
    now
  );
  return res.meta.last_row_id as number;
}

// A stub `fetch` returning canned GitHub issue/milestone JSON, keyed by URL.
// (GitHub's REST vocabulary — a bare github_ref IS a GitHub milestone number.)
function stubFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchGithubRefProgress", () => {
  it("counts closed vs total across an issue-number array", async () => {
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/2": { state: "open" } });
    const p = await fetchGithubRefProgress({ token: "t", repo: "o/r", ref: "[1,2]", fetchImpl });
    expect(p).toEqual({ closed: 1, total: 2 });
  });

  it("reads counts directly from a GitHub milestone object", async () => {
    const fetchImpl = stubFetch({ "/milestones/5": { open_issues: 3, closed_issues: 7, state: "open" } });
    const p = await fetchGithubRefProgress({ token: "t", repo: "o/r", ref: "5", fetchImpl });
    expect(p).toEqual({ closed: 7, total: 10 });
  });

  it("falls back to null on a non-OK GitHub response (expired/revoked token), never throws", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const p = await fetchGithubRefProgress({ token: "stale", repo: "o/r", ref: "[1]", fetchImpl });
    expect(p).toBeNull();
  });

  it("skips a missing issue (404) but keeps counting the resolvable ones", async () => {
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/3": { state: "open" } }); // issue 2 → 404
    const p = await fetchGithubRefProgress({ token: "t", repo: "o/r", ref: "[1,2,3]", fetchImpl });
    expect(p).toEqual({ closed: 1, total: 2 });
  });
});

describe("complete_sprint", () => {
  it("flips a live sprint to 'done'; rejects missing/already-done", async () => {
    const id = await seedSprint("GA", "in_progress");
    const done = await complete_sprint(env.DB, id);
    expect(done.status).toBe("done");
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, id);
    expect(row?.status).toBe("done");
    await expect(complete_sprint(env.DB, id)).rejects.toThrow();     // already done
    await expect(complete_sprint(env.DB, 9999)).rejects.toThrow();   // missing
  });
});

describe("roadmap HTTP routes (session-gated)", () => {
  it("GET /roadmap reads the plan store — narrative + sprints + progress, no live GitHub — and 401s without a session", async () => {
    const { sprints } = await write_plan(
      env.DB,
      { narrative: "Q3 push", sprints: [{ label: "GA", due: "2026-09-01", status: "upcoming", github_ref: 3 }] },
      "andres"
    );
    await upsertProgress(env.DB, sprints[0].id, 4, 6, "event");

    const unauth = await app.request("/roadmap", {}, env);
    expect(unauth.status).toBe(401);

    const res = await app.request("/roadmap", { headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof get_plan>>;
    expect(body.narrative).toBe("Q3 push");
    expect(body.sprints).toHaveLength(1);
    expect(body.sprints[0].label).toBe("GA");
    expect(body.sprints[0].due).toBe("2026-09-01");
    expect(body.sprints[0].active).toBe(false);
    expect(body.sprints[0].progress).toEqual({ closed: 4, total: 6, pct: 67 });
  });

  it("POST /sprints/:id/complete flips status for an authenticated principal", async () => {
    const id = await seedSprint("GA", "in_progress");
    const res = await app.request(`/sprints/${id}/complete`, { method: "POST", headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; sprint: SprintRow };
    expect(body.sprint.status).toBe("done");
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, id);
    expect(row?.status).toBe("done");
  });

  it("POST /sprints/:id/complete 401s without a session and leaves the sprint alone", async () => {
    const id = await seedSprint("GA", "in_progress");
    const res = await app.request(`/sprints/${id}/complete`, { method: "POST" }, env);
    expect(res.status).toBe(401);
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, id);
    expect(row?.status).toBe("in_progress");
  });

  it("POST /sprints/:id/complete 400s on an unknown sprint", async () => {
    const res = await app.request(`/sprints/9999/complete`, { method: "POST", headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("no such sprint");
  });

});

describe("registered MCP get_roadmap tool", () => {
  it("returns the same PlanView shape as GET /roadmap — the plan store, no token plumbing", async () => {
    const { sprints } = await write_plan(
      env.DB,
      { narrative: "MCP view", sprints: [{ label: "GA", due: "2026-09-01", status: "in_progress", github_ref: 3 }] },
      "andres"
    );
    await upsertProgress(env.DB, sprints[0].id, 4, 6, "event");

    const server = buildCanopyMcpServer(env as unknown as Env, { handle: "andres" });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: "get_roadmap", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text) as Awaited<ReturnType<typeof get_plan>>;
      expect(body.narrative).toBe("MCP view");
      expect(body.sprints).toHaveLength(1);
      expect(body.sprints[0].label).toBe("GA");
      expect(body.sprints[0].active).toBe(true);
      expect(body.sprints[0].progress).toEqual({ closed: 4, total: 6, pct: 67 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP registers NO sprint write tool — sprint writes are cookie routes only", async () => {
    const server = buildCanopyMcpServer(env as unknown as Env, { handle: "andres" });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const banned of ["complete_sprint", "create_sprint", "set_sprint_active", "promote_sprint", "propose_sprint"]) {
        expect(names).not.toContain(banned);
      }
      expect(await all(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
