import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestEvent } from "../src/consumer";
import { storePrSummary } from "../src/tools/summarize";
import type { CapturedEvent } from "@shared/contract";
import type { DashboardData } from "@shared/dashboard";

async function cookieFor(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

function mergedPrEvent(number: number, login: string, occurredAt: string): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`,
    event_type: "pr_merged",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: {
        number,
        title: `PR ${number}`,
        body: "some body",
        html_url: `https://github.com/o/r/pull/${number}`,
        merged: true,
        merged_at: occurredAt,
        closed_at: occurredAt,
        user: { login },
        milestone: null,
      },
    }),
    provenance: "webhook",
    occurred_at: occurredAt,
  };
}

function openIssueEvent(number: number, login: string, updatedAt: string): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:opened:${updatedAt}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      action: "opened",
      issue: {
        number,
        title: `[P1] Fix the widget`,
        html_url: `https://github.com/o/r/issues/${number}`,
        state: "open",
        updated_at: updatedAt,
        user: { login },
        assignees: [{ login }],
        labels: ["bug"],
        milestone: null,
      },
    }),
    provenance: "webhook",
    occurred_at: updatedAt,
  };
}

describe("GET /me/dashboard (session-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/me/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the two-list My Work projection for the principal", async () => {
    const now = new Date().toISOString();
    const pr = mergedPrEvent(1, "AndresL230", now);
    await ingestEvent(env.DB, pr, "github-webhook");
    await storePrSummary(env.DB, null, {
      semantic_key: pr.semantic_key,
      pr_number: 1,
      title: "PR 1",
      body: "some body",
    });
    await ingestEvent(env.DB, openIssueEvent(7, "AndresL230", now), "github-webhook");

    const res = await app.request("/me/dashboard", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardData;

    expect(body.person).toBe("Andres"); // login mapped server-side via the people table
    expect(body.degraded).toBe(false);

    expect(body.previousActivity).toHaveLength(1);
    expect(body.previousActivity[0]).toMatchObject({
      number: 1,
      title: "PR 1",
      url: "https://github.com/o/r/pull/1",
      merged: true,
      what: null, // excerpt fallback (no summarizer) → no structured summary
    });

    expect(body.todo).toHaveLength(1);
    expect(body.todo[0]).toMatchObject({
      number: 7,
      title: "Fix the widget",
      priority: "P1",
      labels: ["bug"],
      url: "https://github.com/o/r/issues/7",
    });

    // Revert guard: the old ROADMAP.md/focus dashboard shape is gone for good.
    expect(body).not.toHaveProperty("focus");
    expect(body).not.toHaveProperty("workingNow");
    expect(body).not.toHaveProperty("assignedIssues");
    expect(body).not.toHaveProperty("feed");
  });
});
