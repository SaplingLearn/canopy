import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import { all, first } from "../src/db";
import type { MilestoneRow, PlanRow } from "@shared/rows";

// ADMIN_LOGINS binds "admin-user" in vitest.config.ts — this login clears isAdmin().
const AUTHOR = "admin-user";

// Drive the ACTUAL registered MCP `update_plan` tool through an in-memory MCP
// client/server pair — the same closure production runs (mirrors
// test/mcp.append_feed.test.ts's callTool helper).
async function withClient<T>(login: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildCanopyMcpServer(env as unknown as import("../src/env").Env, { login });
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

async function callTool(login: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  return withClient(login, async (client) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}

describe("registered MCP update_plan tool", () => {
  it("writes as the bearer principal — author stamped from the principal, never the payload", async () => {
    const res = await callTool(AUTHOR, "update_plan", {
      narrative: "shipped via MCP",
      milestones: [{ title: "MCP Milestone", target_date: "2026-08-01", status: "upcoming" }],
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.text);
    expect(body.version).toBe(1);
    expect(body.milestones).toHaveLength(1);

    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE id = 1`);
    expect(plan?.updated_by).toBe(AUTHOR);
    expect(plan?.narrative).toBe("shipped via MCP");

    const milestones = await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].created_by).toBe(AUTHOR);
    expect(milestones[0].title).toBe("MCP Milestone");
  });

  it("milestones default to [] when omitted", async () => {
    const res = await callTool(AUTHOR, "update_plan", { narrative: "narrative only" });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.text);
    expect(body.version).toBe(1);
    expect(body.milestones).toEqual([]);
  });
});

describe("update_plan is admin-only — non-admin principals don't even get the tool", () => {
  it("a non-admin's tools/list omits update_plan but still includes get_roadmap", async () => {
    const { tools } = await withClient("agent", (client) => client.listTools());
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("update_plan");
    expect(names).toContain("get_roadmap");
  });

  it("an admin's tools/list includes update_plan", async () => {
    const { tools } = await withClient(AUTHOR, (client) => client.listTools());
    const names = tools.map((t) => t.name);
    expect(names).toContain("update_plan");
  });

  it("a non-admin calling update_plan gets a tool-not-found MCP error", async () => {
    const res = await callTool("agent", "update_plan", { narrative: "should not land" });
    expect(res.isError).toBeTruthy();
    expect(res.text.toLowerCase()).toContain("not found");

    // Nothing was written — the seeded plan row is untouched.
    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE id = 1`);
    expect(plan?.narrative).not.toBe("should not land");
  });
});
