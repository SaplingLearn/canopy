import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { runBackfill } from "../src/tools/backfill";
import type { Env } from "../src/env";
import type { Summarizer } from "../src/tools/summarize";
import type { EventRow, PrSummaryRow } from "@shared/rows";

// Fixed "now" so the 14-day window is deterministic. threeDaysAgo is inside the
// window; twentyDaysAgo is outside it (must be excluded — and, being sorted
// updated-desc, must also stop pagination).
const NOW = "2026-07-01T00:00:00Z";
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

// Deterministic summarizer stub — never touches Workers AI.
const summarizer: Summarizer = { model: "test-model", summarize: async () => "AI summary" };

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
const oldPr = {
  number: 5,
  title: "Old PR",
  body: "old",
  html_url: "https://github.com/o/r/pull/5",
  merged_at: twentyDaysAgo,
  closed_at: twentyDaysAgo,
  updated_at: twentyDaysAgo, // predates the cutoff → excluded (and stops pagination)
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
  it("captures in-window closed PRs + open issues as backfill events written by the admin principal", async () => {
    const res = await runBackfill(envWith(), "admin-user", {
      fetchImpl: stubFetch([mergedPr, oldPr], [openIssue, prAsIssue]),
      summarizer,
      now: NOW,
    });

    expect(res.ok).toBe(true);
    expect(res.prs).toBe(1); // oldPr excluded by the 14-day window
    expect(res.issues).toBe(1); // prAsIssue excluded (pull_request present)
    expect(res.captured).toBe(2);
    expect(res.unchanged).toBe(0);

    const events = await all<EventRow>(env.DB, `SELECT * FROM events ORDER BY ref_number`);
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.provenance).toBe("backfill"); // provenance post-mapped from "webhook"
      expect(ev.recorded_by).toBe("admin-user"); // writer is the ADMIN principal, not "github-webhook"
    }
    // The merged PR was captured as pr_merged (merged_at != null).
    const pr = events.find((e) => e.ref_number === 10)!;
    expect(pr.event_type).toBe("pr_merged");
    expect(pr.subject_login).toBe("octocat");

    // The PR summary projection ran for the newly-written PR event.
    const summary = await first<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE pr_number = ?`, 10);
    expect(summary).toBeTruthy();
    expect(summary?.summary).toBe("AI summary");
  });

  it("is idempotent — a second run over the same GitHub state writes nothing new", async () => {
    const fetchImpl = stubFetch([mergedPr], [openIssue]);
    const first = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, now: NOW });
    expect(first.captured).toBe(2);

    const second = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, now: NOW });
    expect(second.ok).toBe(true);
    expect(second.captured).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(2); // INSERT OR IGNORE on semantic_key
  });

  it("returns {ok:false} (no throw, no writes) when the service token is missing", async () => {
    const res = await runBackfill(envWith({ GITHUB_SERVICE_TOKEN: undefined }), "admin-user", {
      fetchImpl: stubFetch([mergedPr], [openIssue]),
      summarizer,
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("service token or repo");
    expect(res).toMatchObject({ captured: 0, unchanged: 0, prs: 0, issues: 0 });
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(0);
  });
});
