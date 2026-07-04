import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { runBackfill } from "../src/tools/backfill";
import type { Env } from "../src/env";
import type { Summarizer } from "../src/tools/summarize";
import type { EventRow, PrSummaryRow, IssueSummaryRow } from "@shared/rows";

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
  body: "Full description of the bug.",
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

const unassignedIssue = {
  number: 30,
  title: "Untriaged bug",
  html_url: "https://github.com/o/r/issues/30",
  state: "open",
  updated_at: threeDaysAgo,
  user: { login: "octocat" },
  assignees: [], // no assignee → "opened", never summarized
  labels: [],
  milestone: null,
  body: "Nobody has looked at this yet.",
};

function makePr(number: number): typeof mergedPr {
  return {
    number,
    title: `PR ${number}`,
    body: `body ${number}`,
    html_url: `https://github.com/o/r/pull/${number}`,
    merged_at: threeDaysAgo,
    closed_at: threeDaysAgo,
    updated_at: threeDaysAgo,
    user: { login: "octocat" },
    milestone: null,
  };
}
const prA = makePr(100);
const prB = makePr(101);
const prC = makePr(102);

describe("runBackfill", () => {
  it("captures ALL closed PRs (full history, no recency window) + open issues, written by the admin principal", async () => {
    const summarizer = countingSummarizer("AI summary");
    const issueSummarizer = countingSummarizer("Issue AI summary");
    const res = await runBackfill(envWith(), "admin-user", {
      fetchImpl: stubFetch([mergedPr, olderPr], [openIssue, prAsIssue]),
      summarizer,
      issueSummarizer,
      summaryCallDelayMs: 0,
    });

    expect(res.ok).toBe(true);
    expect(res.prs).toBe(2); // both mergedPr and olderPr — no cutoff anymore
    expect(res.issues).toBe(1); // prAsIssue excluded (pull_request present)
    expect(res.captured).toBe(3); // 2 PR events + 1 issue event
    expect(res.unchanged).toBe(0);
    expect(res.summarized).toBe(3); // one summary per newly-captured PR + the assigned issue (shared budget)
    expect(res.summaryBudgetExhausted).toBe(false); // well under the default batch limit
    expect(res.prSummarizedCount).toBe(2); // both newly-summarized PRs count toward "done" (model !== 'excerpt')
    expect(res.issueSummarizedCount).toBe(1); // openIssue is assigned → summarized
    expect(res.issuesToSummarize).toBe(1);

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
    const issueSummarizer = countingSummarizer("Issue summary.");
    const fetchImpl = stubFetch([mergedPr], [openIssue]);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0 });
    expect(firstRun.captured).toBe(2);

    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0 });
    expect(secondRun.ok).toBe(true);
    expect(secondRun.captured).toBe(0);
    expect(secondRun.unchanged).toBe(2);
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(2); // INSERT OR IGNORE on semantic_key
  });

  it("retroactively re-summarizes a PR whose existing summary fell back to excerpt", async () => {
    const nullSummarizer: Summarizer = { model: "stub", summarize: async () => null }; // forces the excerpt fallback
    const fetchImpl = stubFetch([mergedPr], []);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: nullSummarizer, summaryCallDelayMs: 0 });
    expect(firstRun.summarized).toBe(1);
    expect(firstRun.prSummarizedCount).toBe(0); // excerpt fallback never counts as "done"

    // Second run: a real summarizer is available now — the stored summary is
    // still the excerpt fallback (model:'excerpt') → re-summarized.
    const realSummarizer = countingSummarizer("A real AI summary.");
    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer: realSummarizer, summaryCallDelayMs: 0 });
    expect(secondRun.captured).toBe(0);
    expect(secondRun.unchanged).toBe(1);
    expect(secondRun.summarized).toBe(1);
    expect(secondRun.prSummarizedCount).toBe(1);
    expect(realSummarizer.calls).toBe(1);
  });

  it("skips re-summarizing a PR that already has a real (non-excerpt) summary", async () => {
    const summarizer = countingSummarizer("Plain prose, no headings — the new richer style.");
    const fetchImpl = stubFetch([mergedPr], []);
    const firstRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, summaryCallDelayMs: 0 });
    expect(firstRun.summarized).toBe(1);
    expect(firstRun.prSummarizedCount).toBe(1);
    expect(summarizer.calls).toBe(1);

    // Second run: model !== 'excerpt' already → skipped, no second summarizer
    // call, regardless of the stored text's exact shape.
    const secondRun = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, summaryCallDelayMs: 0 });
    expect(secondRun.summarized).toBe(0);
    expect(secondRun.prSummarizedCount).toBe(1);
    expect(summarizer.calls).toBe(1);

    const summary = await first<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE pr_number = ?`, 10);
    expect(summary?.summary).toBe("Plain prose, no headings — the new richer style.");
  });

  it("returns {ok:false} (no throw, no writes) when the service token is missing", async () => {
    const res = await runBackfill(envWith({ GITHUB_SERVICE_TOKEN: undefined }), "admin-user", {
      fetchImpl: stubFetch([mergedPr], [openIssue]),
      summarizer: countingSummarizer("AI summary"),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("service token or repo");
    expect(res).toMatchObject({ captured: 0, unchanged: 0, summarized: 0, summaryBudgetExhausted: false, prSummarizedCount: 0, prs: 0, issues: 0 });
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(0);
  });

  it("caps AI summarization at summaryBatchLimit per invocation; a follow-up run finishes the rest", async () => {
    const summarizer = countingSummarizer("**What changed:** Summary.");
    const fetchImpl = stubFetch([prA, prB, prC], []);

    const firstRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl,
      summarizer,
      summaryBatchLimit: 2,
      summaryCallDelayMs: 0,
    });
    expect(firstRun.summarized).toBe(2);
    expect(firstRun.summaryBudgetExhausted).toBe(true);
    expect(firstRun.prSummarizedCount).toBe(2); // 2 of 3 done so far — the "X of Y" progress bar's numerator
    expect(summarizer.calls).toBe(2);

    const secondRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl,
      summarizer,
      summaryBatchLimit: 2,
      summaryCallDelayMs: 0,
    });
    expect(secondRun.summarized).toBe(1); // only prC was left
    expect(secondRun.summaryBudgetExhausted).toBe(false);
    expect(secondRun.prSummarizedCount).toBe(3); // all 3 now done
    expect(summarizer.calls).toBe(3);

    const rows = await all<PrSummaryRow>(env.DB, `SELECT pr_number FROM pr_summaries ORDER BY pr_number`);
    expect(rows.map((r) => r.pr_number)).toEqual([100, 101, 102]);
  });

  it("waits summaryCallDelayMs between summarizer calls", async () => {
    const summarizer = countingSummarizer("**What changed:** Summary.");
    const start = Date.now();
    await runBackfill(envWith(), "admin-user", {
      fetchImpl: stubFetch([prA, prB], []),
      summarizer,
      summaryBatchLimit: 10,
      summaryCallDelayMs: 40,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // one delay between the 2 summarizer calls
  });
});

describe("runBackfill — issue summarization", () => {
  it("summarizes an assigned issue and skips it on a second run once done", async () => {
    const summarizer = countingSummarizer("PR summary."); // unused here (no PRs in this fixture set)
    const issueSummarizer = countingSummarizer("What the issue is and what to do.");
    const fetchImpl = stubFetch([], [openIssue]);

    const firstRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0,
    });
    expect(firstRun.issuesToSummarize).toBe(1);
    expect(firstRun.issueSummarizedCount).toBe(1);
    expect(issueSummarizer.calls).toBe(1);

    const secondRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0,
    });
    expect(secondRun.issueSummarizedCount).toBe(1); // already has a real summary → skipped
    expect(issueSummarizer.calls).toBe(1); // no second call

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 20);
    expect(rows[0].summary).toBe("What the issue is and what to do.");
  });

  it("never summarizes an unassigned open issue", async () => {
    const issueSummarizer = countingSummarizer("should never be called");
    const res = await runBackfill(envWith(), "admin-user", {
      fetchImpl: stubFetch([], [unassignedIssue]),
      summarizer: countingSummarizer("x"),
      issueSummarizer,
      summaryCallDelayMs: 0,
    });
    expect(res.issuesToSummarize).toBe(0);
    expect(res.issueSummarizedCount).toBe(0);
    expect(issueSummarizer.calls).toBe(0);
    const rows = await all(env.DB, `SELECT * FROM issue_summaries`);
    expect(rows.length).toBe(0);
  });

  it("shares one AI-call budget across PRs and issues — PRs consume it first", async () => {
    const summarizer = countingSummarizer("PR summary.");
    const issueSummarizer = countingSummarizer("Issue summary.");
    const fetchImpl = stubFetch([prA, prB], [openIssue]);

    const firstRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl, summarizer, issueSummarizer, summaryBatchLimit: 2, summaryCallDelayMs: 0,
    });
    expect(firstRun.summarized).toBe(2); // budget fully spent on the 2 PRs
    expect(firstRun.summaryBudgetExhausted).toBe(true);
    expect(summarizer.calls).toBe(2);
    expect(issueSummarizer.calls).toBe(0); // no budget left for the issue this run
    expect(firstRun.issueSummarizedCount).toBe(0);

    // A follow-up run finishes the issue now that the PR backlog is clear.
    const secondRun = await runBackfill(envWith(), "admin-user", {
      fetchImpl, summarizer, issueSummarizer, summaryBatchLimit: 2, summaryCallDelayMs: 0,
    });
    expect(secondRun.summarized).toBe(1); // just the issue — both PRs already summarized
    expect(issueSummarizer.calls).toBe(1);
    expect(secondRun.issueSummarizedCount).toBe(1);
  });
});
