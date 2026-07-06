import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { EventRow } from "@shared/rows";
import type { Env } from "../src/env";
import worker from "../src/index";
import {
  verifyGithubSignature,
  eventsFromDelivery,
  progressFromIssueEvent,
  handleGithubWebhook,
} from "../src/webhook";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";
import issueClosed from "./fixtures/gh-issue-closed.json";
import type { Summarizer, PrSummary, IssueSummary } from "../src/tools/summarize";
import type { IssueSummaryRow } from "@shared/rows";

const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding

// GitHub's own signing recipe — HMAC-SHA256 hex, prefixed `sha256=`.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("https://x/webhook/github", { method: "POST", headers, body });
}

// A correctly-signed delivery to the handler (the common happy path).
async function postWebhook(
  eventName: string,
  payload: unknown,
  e: Env = env,
  opts?: { summarizer?: Summarizer<PrSummary> | null; issueSummarizer?: Summarizer<IssueSummary> | null }
): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = await sign(SECRET, body);
  return handleGithubWebhook(
    req(body, { "x-github-event": eventName, "x-hub-signature-256": sig, "content-type": "application/json" }),
    e,
    opts
  );
}

describe("handleGithubWebhook — the third auth class", () => {
  it("valid signature + pr-merged → 200, one events row; redelivery → captured:0 unchanged:1", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0 });

    let rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("pr_merged");
    expect(rows[0].subject_login).toBe("AndresL230");
    expect(rows[0].recorded_by).toBe("github-webhook"); // fixed writer principal
    expect(rows[0].semantic_key).toBe("gh:pr:42:merged");

    // Redelivery of the SAME body: the UNIQUE semantic_key dedupes (INSERT OR IGNORE).
    const res2 = await postWebhook("pull_request", prMerged);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, captured: 0, unchanged: 1 });
    rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1); // still exactly one row
  });

  it("bad signature → 401 and zero rows written", async () => {
    const body = JSON.stringify(prMerged);
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef" }),
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(0);
  });

  it("missing signature header → 401", async () => {
    const body = JSON.stringify(prMerged);
    const res = await handleGithubWebhook(req(body, { "x-github-event": "pull_request" }), env);
    expect(res.status).toBe(401);
  });

  it("secret unset → 401 (never trusts an unsigned surface)", async () => {
    const body = JSON.stringify(prMerged);
    const sig = await sign(SECRET, body);
    const noSecret = { ...env, GITHUB_WEBHOOK_SECRET: undefined } as Env;
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sig }),
      noSecret
    );
    expect(res.status).toBe(401);
  });

  it("unhandled event name → 200 {ok:true, ignored:true} AFTER signature verification", async () => {
    const body = JSON.stringify({ zen: "Keep it simple." });
    const sig = await sign(SECRET, body);
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "ping", "x-hub-signature-256": sig }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(0);
  });

  it("default export routes POST /webhook/github to the handler", async () => {
    const body = JSON.stringify(prMerged);
    const sig = await sign(SECRET, body);
    const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sig }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("pr_merged");
  });

  it("captures the PR base branch in raw (footer 'into <base>' source)", async () => {
    await postWebhook("pull_request", prMerged, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE semantic_key = 'gh:pr:42:merged'`);
    const raw = JSON.parse(rows[0].raw) as { pr: { base: { ref: string } | null } };
    expect(raw.pr.base).toEqual({ ref: "main" });
  });

  it("captures the issue milestone title and due date in raw (Milestone row source)", async () => {
    await postWebhook("issues", issueAssigned, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE event_type = 'issue'`);
    const raw = JSON.parse(rows[0].raw) as { issue: { milestone: { number: number; title: string | null; due_on: string | null } } };
    expect(raw.issue.milestone).toMatchObject({ number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" });
  });
});

describe("verifyGithubSignature", () => {
  it("true for a good sig; false for malformed/absent/tampered (never throws)", async () => {
    const body = "the raw delivery bytes";
    const good = await sign(SECRET, body);
    expect(await verifyGithubSignature(SECRET, body, good)).toBe(true);
    expect(await verifyGithubSignature(SECRET, body, "sha256=zzzz")).toBe(false); // non-hex
    expect(await verifyGithubSignature(SECRET, body, "sha256=abc")).toBe(false); // odd length
    expect(await verifyGithubSignature(SECRET, body, "garbage")).toBe(false); // no prefix
    expect(await verifyGithubSignature(SECRET, body, null)).toBe(false); // absent
    expect(await verifyGithubSignature(SECRET, "tampered body", good)).toBe(false); // body changed
  });
});

describe("eventsFromDelivery — pure derivation", () => {
  it("issues/assigned → subject is the assignee; key embeds action+assignee+updated_at", () => {
    const events = eventsFromDelivery("issues", issueAssigned);
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event_type).toBe("issue");
    expect(e.subject_login).toBe("Jose-Gael-Cruz-Lopez");
    expect(e.ref_number).toBe(17);
    expect(e.semantic_key).toBe("gh:issue:17:assigned:Jose-Gael-Cruz-Lopez:2026-07-01T17:05:00Z");
    expect(e.occurred_at).toBe("2026-07-01T17:05:00Z");
    expect(e.provenance).toBe("webhook");
    const raw = JSON.parse(e.raw);
    expect(raw.action).toBe("assigned");
    expect(raw.issue.labels).toEqual(["P1", "backend"]); // label objects flattened to names
    expect(raw.issue.milestone).toEqual({
      number: 3,
      title: "Reliable event capture",
      due_on: "2026-07-20T07:00:00Z",
      open_issues: 2,
      closed_issues: 4,
    });
    expect(raw.issue.body).toBe("Full description of what needs wiring."); // NEW: needed by the issue summarizer
  });

  it("pr closed+merged → pr_merged with the merged key and merged_at as occurred_at", () => {
    const events = eventsFromDelivery("pull_request", prMerged);
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event_type).toBe("pr_merged");
    expect(e.semantic_key).toBe("gh:pr:42:merged");
    expect(e.subject_login).toBe("AndresL230");
    expect(e.ref_number).toBe(42);
    expect(e.occurred_at).toBe("2026-07-01T18:24:00Z");
    const raw = JSON.parse(e.raw);
    expect(raw.pr.merged).toBe(true);
    expect(raw.pr.milestone).toEqual({ number: 3 }); // PR milestone slice is number-only
  });

  it("returns [] for a PR masquerading as an issue and for unknown/unhandled actions", () => {
    expect(eventsFromDelivery("issues", { action: "assigned", issue: { number: 1, pull_request: { url: "x" } } })).toEqual([]);
    expect(eventsFromDelivery("issues", { action: "labeled", issue: { number: 1, updated_at: "t", user: { login: "x" }, assignees: [] } })).toEqual([]);
    expect(eventsFromDelivery("pull_request", { action: "opened", pull_request: { number: 1 } })).toEqual([]);
    expect(eventsFromDelivery("push", {})).toEqual([]);
    expect(eventsFromDelivery("issues", null)).toEqual([]);
  });
});

describe("progressFromIssueEvent — pure derivation", () => {
  it("reads the milestone counts (total = open + closed)", () => {
    expect(progressFromIssueEvent(issueClosed)).toEqual({ milestoneNumber: 3, closed: 5, total: 6 });
  });

  it("null when there is no milestone on the issue", () => {
    expect(progressFromIssueEvent({ issue: { number: 1 } })).toBeNull();
    expect(progressFromIssueEvent(null)).toBeNull();
  });
});

describe("webhook → issue summarize wiring", () => {
  it("an assigned issue event → one issue_summaries row keyed by issue number", async () => {
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "What it is and what to do.", next_step: null }) };
    const res = await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 17);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("What it is and what to do.");
  });

  it("a non-assigned issue action (closed) never reaches storeIssueSummary — zero issue_summaries rows", async () => {
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "should never be called", next_step: null }) };
    const res = await postWebhook("issues", issueClosed, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all(env.DB, `SELECT * FROM issue_summaries`);
    expect(rows.length).toBe(0);
  });

  it("still runs progressSeam for an assigned issue event (both seams fire, not either/or)", async () => {
    // progressSeam only writes a milestone_progress row for a milestone that
    // already exists with a matching github_ref (see test/progress.test.ts's
    // seedMilestone pattern) — seed one matching issueAssigned's milestone (3)
    // so the assertion below actually exercises applyEventProgress.
    await run(
      env.DB,
      `INSERT INTO milestones (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      "M",
      "2026-08-01",
      "in_progress",
      "3",
      nowIso(),
      "andres"
    );
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "summary", next_step: null }) };
    await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    const progress = await all(env.DB, `SELECT * FROM milestone_progress`);
    expect(progress.length).toBe(1); // issueAssigned carries a milestone — progressSeam still wrote it
  });
});
