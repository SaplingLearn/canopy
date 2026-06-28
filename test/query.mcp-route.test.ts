import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { propose_doc_update, promote_doc } from "../src/tools/writes";
import type { QueryResult } from "@shared/contract";

const AUTHOR = "agent";

// Drive the ACTUAL registered MCP `query` tool through an in-memory MCP
// client/server pair — the same closures production runs, not a re-impl.
async function callQuery(args: Record<string, unknown>): Promise<QueryResult> {
  const server = buildCanopyMcpServer(env as unknown as import("../src/env").Env, { login: AUTHOR });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({ name: "query", arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    return JSON.parse(res.content[0].text) as QueryResult;
  } finally {
    await client.close();
    await server.close();
  }
}

async function authedCookie(login: string): Promise<string> {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

async function searchRoute(qs: string): Promise<QueryResult> {
  const cookie = await authedCookie("human");
  const res = await app.request(`/search?${qs}`, { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: QueryResult };
  return body.result;
}

describe("registered MCP query tool + live GET /search route", () => {
  it("the MCP query tool returns the assembled QueryResult envelope from the real registration", async () => {
    await propose_doc_update(env.DB, { slug: "live-doc", section: "reference", title: "Live Doc", body: "the promoted falcon body", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(env.DB, "live-doc", 1, AUTHOR);

    const r = await callQuery({ q: "falcon" });
    expect(r.meta.engine).toBe("fts5");
    const hit = r.primary.find((p) => p.id === "live-doc");
    expect(hit?.authority).toBe("live");
    expect(hit?.body).toBe("the promoted falcon body");
  });

  it("MCP surfaces staged (agent default include_staged:true); /search does not (human default false)", async () => {
    // An UNPROMOTED doc — found by title (its live body is empty until promotion).
    await propose_doc_update(env.DB, { slug: "secret-plan", section: "reference", title: "Pelican Plan", body: "the unpromoted pelican details", change_summary: "s", confidence: "high" }, AUTHOR);

    // Agent via the registered MCP tool: sees it, flagged unpromoted, staged body reached.
    const mcp = await callQuery({ q: "pelican" });
    const a = mcp.primary.find((p) => p.id === "secret-plan");
    expect(a?.authority).toBe("unpromoted");
    expect(a?.body).toBe("the unpromoted pelican details");

    // Human via the live route: the unpromoted doc is withheld entirely.
    const human = await searchRoute("q=pelican");
    expect(human.primary.find((p) => p.id === "secret-plan")).toBeUndefined();
    expect(human.pointers.find((p) => p.id === "secret-plan")).toBeUndefined();
  });

  it("/search returns { result } and a promoted doc is visible to humans", async () => {
    await propose_doc_update(env.DB, { slug: "human-doc", section: "reference", title: "Human Doc", body: "the heron is promoted", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(env.DB, "human-doc", 1, AUTHOR);

    const result = await searchRoute("q=heron");
    expect(result.meta.engine).toBe("fts5");
    const hit = result.primary.find((p) => p.id === "human-doc");
    expect(hit?.authority).toBe("live");
    expect(hit?.staged_body).toBeNull();
  });

  it("/search honors the types csv filter", async () => {
    await propose_doc_update(env.DB, { slug: "owl-doc", section: "reference", title: "Owl Doc", body: "owl content", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(env.DB, "owl-doc", 1, AUTHOR);
    await env.DB.prepare(`INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, 'owl feed', 'owl content', NULL, ?)`)
      .bind(AUTHOR, "2026-01-01T00:00:00Z").run();

    const docsOnly = await searchRoute("q=owl&types=doc");
    expect(docsOnly.primary.every((p) => p.type === "doc")).toBe(true);
    expect([...docsOnly.primary, ...docsOnly.pointers].some((p) => p.id === "owl-doc")).toBe(true);
  });

  it("/search requires a session (401 without a cookie)", async () => {
    const res = await app.request("/search?q=anything", {}, env);
    expect(res.status).toBe(401);
  });
});
