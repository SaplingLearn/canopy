import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestFocusUpdate } from "../src/consumer";
import { append_feed } from "../src/tools/writes";

async function cookieFor(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("GET /me/dashboard (session-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/me/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns focus + feed for the principal (no GitHub token in test env → degraded)", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "wire My Work" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "landed route", artifacts: { prs: [], commits: [], issues: [] } });

    const res = await app.request("/me/dashboard", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      person: string | null; focus: { workingOn: string } | null;
      feed: unknown[]; degraded: boolean; workingNow: unknown; assignedIssues: unknown[];
    };
    expect(body.person).toBe("Andres");          // login mapped server-side
    expect(body.focus?.workingOn).toBe("wire My Work");
    expect(body.feed).toHaveLength(1);
    expect(body.degraded).toBe(true);            // no stored github_token for this user
    expect(body.workingNow).toBeNull();
    expect(body.assignedIssues).toEqual([]);
  });
});
