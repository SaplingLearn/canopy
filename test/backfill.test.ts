import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { runBackfill } from "../src/tools/backfill";
import type { Env } from "../src/env";
import type { Summarizer } from "../src/tools/summarize";
import type { EventRow, PrSummaryRow } from "@shared/rows";

const threeDaysAgo = "2026-06-28T00:00:00Z";
const twentyDaysAgo = "2026-06-11T00:00:00Z";

// A Response-level fetch stub (the pool exports no fetch mock) — mirrors
// test/roadmap.test.ts / test/progress.test.ts. Routes by path substring: the
// pulls list vs the issues list.
function stubFetch(prs: unknown[], issues: unknown[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("/pulls") ? prs : u.includes("/issues") ? issues : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

// Deterministic summarizer stub — never touches Workers AI. Counts calls so
// tests can assert the retroactive-resummarize / skip-if-structured behavior.
function countingSummarizer(summary: string): Summarizer & { calls: number } {
  const s = {
    model: "test-model",
    calls: 0,
    async summarize() {
      s.calls++;
      return summary;
    },
  };
  return s;
}

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: "o/r", ...overrides };
}

const mergedPr = {
  number: 10,
  title: "Add feature",
  body: "This PR adds a feature.",
  html_url: "https://github.com/o/r/pull/10",
  merged_at: threeDaysAgo, // merged → derived merged:true from merged_at != null
  closed_at: threeDaysAgo,
  updated_at: threeDaysAgo,
  user: { login: "octocat" },
  milestone: null,
};
const olderPr = {
  number: 5,
  title: "Old PR",
  body: "old",
  html_url: "https://github.com/o/r/pull/5",
  merged_at: twentyDaysAgo,
  closed_at: twentyDaysAgo,
  updated_at: twentyDaysAgo, // older than the old 14-day window — now included too (full history, no cutoff)
  user: { login: "octocat" },
  milestone: null,
};
const openIssue = {
  number: 20,
  title: "Fix bug",
  html_url: "https://github.com/o/r/issues/20",
  state: "open",
  updated_at: threeDaysAgo,
  user: { login: "octocat" },
  assignees: [{ login: "octocat" }], // has an assignee → "assigned"
  labels: ["bug"],
  milestone: null,
};
const prAsIssue = {
  number: 21,
  title: "A PR the issues endpoint also returned",
  html_url: "https://github.com/o/r/pull/21",
  state: "open",
  updated_at: threeDaysAgo,
  user: { login: "octocat" },
  pull_request: { url: "https://api.github.com/repos/o/r/pulls/21" }, // → skipped
  assignees: [],
  labels: [],
  milestone: null,
};

describe("runBackfill", () => {
  it("captures ALL closed PRs (full history, no recency window) + open issues, written by the admin principal", async () => {
    const summarizer = countingSummarizer("AI summary");
    const res = await runBackfill(envWith(), "admin-user", {
      fetchImpl: stubFetch([mergedPr, olderPr], [openIssue, prAsIssue]),
      summarizer,
    });

    expect(res.ok).toBe(true);
    expect(res.prs).toBe(2); // both mergedPr and olderPr — no cutoff anymore
    expect(res.issues).toBe(1); // prAsIssue excluded (pull_request present)
    expect(res.captured).toBe(3); // 2 PR events + 1 issue event
    expect(res.unchanged).toBe(0);
    expect(res.summarized).toBe(2); // one summary per newly-captured PR

    const events = await all<EventRow>(env.DB, `SELECT * FROM events ORDER BY ref_number`);
    expect(events).toHaveLength(3);
    for (const ev of events) {
      expect(ev.provenance).toBe("backfill"); // provenance post-mapped from "webhook"
      expect(ev.recorded_by).toBe("admin-user"); // writer is the ADMIN principal, not "github-webhook"
    }
    // The merged PR was captured as pr_merged (merged_at != null).
    const pr = events.find((e) => e.ref_number === 10)!;
    expect(pr.event_type).toBe("pr_merged");
    expect(pr.subject_login).toBe("octocat");

    // The PR summary projection ran for both newly-written PR events.
    const summary = await first<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE pr_number = ?`, 10);
    expect(summary).toBeTruthy();
    expect(summary?.summary).toBe("AI summary");
  });

  it("is idempotent on event capture — a second run over the same GitHub state writes no new events", async () => {
    const summarizer = countingSummarizer("**What changed:** AI summary");
    const fetchImpl = stubFetch([mergedPr], [openIssue]);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer });
    expect(firstRun.captured).toBe(2);

    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer });
    expect(secondRun.ok).toBe(true);
    expect(secondRun.captured).toBe(0);
    expect(secondRun.unchanged).toBe(2);
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(2); // INSERT OR IGNORE on semantic_key
  });

  it("retroactively re-summarizes a PR whose existing summary is NOT structured", async () => {
    const plainSummarizer = countingSummarizer("Plain prose summary, not structured.");
    const fetchImpl = stubFetch([mergedPr], []);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: plainSummarizer });
    expect(firstRun.summarized).toBe(1);
    expect(plainSummarizer.calls).toBe(1);

    // Second run: the event is unchanged, but the stored summary is still
    // plain prose (doesn't match the structured convention) → re-summarized.
    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: plainSummarizer });
    expect(secondRun.captured).toBe(0);
    expect(secondRun.unchanged).toBe(1);
    expect(secondRun.summarized).toBe(1);
    expect(plainSummarizer.calls).toBe(2);
  });

  it("skips re-summarizing a PR whose existing summary is already structured", async () => {
    const structuredSummarizer = countingSummarizer("**What changed:** Fixed the thing.");
    const fetchImpl = stubFetch([mergedPr], []);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: structuredSummarizer });
    expect(firstRun.summarized).toBe(1);
    expect(structuredSummarizer.calls).toBe(1);

    // Second run: the stored summary already matches the structured convention
    // → skipped, no second summarizer call.
    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: structuredSummarizer });
    expect(secondRun.summarized).toBe(0);
    expect(structuredSummarizer.calls).toBe(1);

    const summary = await first<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE pr_number = ?`, 10);
    expect(summary?.summary).toBe("**What changed:** Fixed the thing.");
  });

  it("returns {ok:false} (no throw, no writes) when the service token is missing", async () => {
    const res = await runBackfill(envWith({ GITHUB_SERVICE_TOKEN: undefined }), "admin-user", {
      fetchImpl: stubFetch([mergedPr], [openIssue]),
      summarizer: countingSummarizer("AI summary"),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("service token or repo");
    expect(res).toMatchObject({ captured: 0, unchanged: 0, summarized: 0, prs: 0, issues: 0 });
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(0);
  });
});
