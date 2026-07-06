/**
 * Task 14 render tests — My Work screen rebuild (two lists, markdown summaries).
 *
 * Tests pure helper functions exported from web/src/render.ts:
 *  • prActivityCard — a merged/closed PR card with an injected-markdown summary
 *  • todoCard — an assigned-issue card, NO markdown
 *  • render() over a mywork-populated AppState — section labels present, old
 *    "Working on now" focus headline gone (behavioral revert guard).
 *
 * All tests are pure (no D1 / Miniflare bindings); mirrors test/render.triage.test.ts's
 * mockMd pattern so we never call the real renderMarkdown (DOMPurify) here.
 */
import { describe, it, expect } from "vitest";
import { prActivityCard, todoCard, render, initialState } from "../web/src/render";
import type { MyWorkPr, MyWorkTodo, DashboardData } from "@shared/dashboard";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Mock markdown function — returns body wrapped in a <div> for testability. */
const mockMd = (body: string) => `<div class="mock-md">${body}</div>`;

function makePr(overrides: Partial<MyWorkPr> = {}): MyWorkPr {
  return {
    number: 42,
    title: "Fix the thing",
    displayTitle: null,
    url: "https://github.com/SaplingLearn/sapling/pull/42",
    merged: true,
    occurredAt: new Date().toISOString(),
    summary: "Fixed **the thing** that was broken.",
    impact: null,
    baseRef: null,
    ...overrides,
  };
}

function makeTodo(overrides: Partial<MyWorkTodo> = {}): MyWorkTodo {
  return {
    number: 7,
    title: "Investigate flaky test",
    displayTitle: null,
    priority: "P1",
    labels: ["bug", "flaky", "ci", "extra"],
    url: "https://github.com/SaplingLearn/sapling/issues/7",
    updatedAt: new Date().toISOString(),
    summary: null,
    milestone: null,
    nextStep: null,
    ...overrides,
  };
}

// ── prActivityCard ───────────────────────────────────────────────────────────

describe("prActivityCard", () => {
  it("embeds the injected markdownFn output for the summary", () => {
    const html = prActivityCard(makePr(), mockMd);
    expect(html).toContain("mock-md");
    expect(html).toContain("Fixed **the thing**");
  });

  it("shows a MERGED chip with the green token when merged", () => {
    const html = prActivityCard(makePr({ merged: true }), mockMd);
    expect(html).toContain("MERGED");
    expect(html).toContain("var(--green)");
  });

  it("shows a CLOSED chip (not green) when not merged", () => {
    const html = prActivityCard(makePr({ merged: false }), mockMd);
    expect(html).toContain("CLOSED");
    expect(html).not.toContain("MERGED");
  });

  it("links #<number> to pr.url with target _blank rel noopener", () => {
    const pr = makePr({ number: 99, url: "https://github.com/SaplingLearn/sapling/pull/99" });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("#99");
    expect(html).toContain(pr.url);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it("falls back to linkifyRefs raw text when summary is null (no markdownFn call)", () => {
    const html = prActivityCard(makePr({ summary: null }), mockMd);
    expect(html).not.toContain("mock-md");
  });

  it("XSS: a <script> in the PR title is escaped, not executed", () => {
    const html = prActivityCard(makePr({ title: '<script>alert(1)</script>' }), mockMd);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("scheme-guard: a javascript: url is neutered to href=\"#\"", () => {
    const html = prActivityCard(makePr({ url: "javascript:alert(1)" }), mockMd);
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("renders structured What changed + Why as separate labeled rows", () => {
    const pr = makePr({ summary: "**What changed:** Fixed the login bug.\n**Why:** Users were logged out unexpectedly." });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("What changed");
    expect(html).toContain("Why");
    expect(html).toContain("Fixed the login bug.");
    expect(html).toContain("Users were logged out unexpectedly.");
    expect(html).not.toContain("**What changed:**");
    expect(html).not.toContain("**Why:**");
  });

  it("omits the Why row when the structured summary has no Why", () => {
    const pr = makePr({ summary: "**What changed:** Fixed the login bug." });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("What changed");
    expect(html).not.toContain("Why");
    expect(html).not.toContain("**What changed:**");
  });

  it("falls back to a single 'Summary' row for a non-conforming summary (legacy/excerpt)", () => {
    const pr = makePr({ summary: "Fixed the login bug that was affecting users." });
    const html = prActivityCard(pr, mockMd);
    expect(html).not.toContain("What changed");
    expect(html).toContain("Summary");
    expect(html).toContain("mock-md");
  });

  it("renders an Impact row when pr.impact is set; collapses it when null", () => {
    const withImpact = prActivityCard(makePr({ impact: "Users stay logged in across deploys." }), mockMd);
    expect(withImpact).toContain("Impact");
    expect(withImpact).toContain("Users stay logged in across deploys.");
    const withoutImpact = prActivityCard(makePr({ impact: null }), mockMd);
    expect(withoutImpact).not.toContain("Impact");
  });

  it("footer shows '· into <baseRef>' in a mono span when set; omits the suffix when null", () => {
    const withBase = prActivityCard(makePr({ baseRef: "main" }), mockMd);
    expect(withBase).toContain("· into <span");
    expect(withBase).toContain("main");
    const withoutBase = prActivityCard(makePr({ baseRef: null }), mockMd);
    expect(withoutBase).not.toContain("· into");
  });

  it("renders displayTitle when set, falling back to the raw title when null", () => {
    const humanized = prActivityCard(makePr({ displayTitle: "Keep users signed in" }), mockMd);
    expect(humanized).toContain("Keep users signed in");
    expect(humanized).not.toContain("Fix the thing");
    const fallback = prActivityCard(makePr({ displayTitle: null }), mockMd);
    expect(fallback).toContain("Fix the thing");
  });

  it("the number pill is the card's only anchor", () => {
    const html = prActivityCard(makePr(), mockMd);
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });
});

// ── todoCard ──────────────────────────────────────────────────────────────────

describe("todoCard", () => {
  it("shows the priority and labels (capped at 3)", () => {
    const html = todoCard(makeTodo());
    expect(html).toContain("P1");
    expect(html).toContain("bug");
    expect(html).toContain("flaky");
    expect(html).toContain("ci");
    expect(html).not.toContain("extra");
  });

  it("shows #<number> and the title, linked to t.url", () => {
    const todo = makeTodo({ number: 123, url: "https://github.com/SaplingLearn/sapling/issues/123" });
    const html = todoCard(todo);
    expect(html).toContain("#123");
    expect(html).toContain(todo.url);
  });

  it("does NOT contain the mock-md wrapper — no markdown rendering", () => {
    const html = todoCard(makeTodo());
    expect(html).not.toContain("mock-md");
    expect(html).not.toContain("cnpy-md");
  });

  it("XSS: a malicious title is escaped", () => {
    const html = todoCard(makeTodo({ title: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("scheme-guard: a javascript: url is neutered to href=\"#\"", () => {
    const html = todoCard(makeTodo({ url: "javascript:alert(1)" }));
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("omits the priority chip when priority is null", () => {
    const html = todoCard(makeTodo({ priority: null }));
    expect(html).not.toContain("P0");
    expect(html).not.toContain("P1");
    expect(html).not.toContain("P2");
    expect(html).not.toContain("P3");
  });

  it("shows a right-aligned relative 'updated' time derived from t.updatedAt", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const html = todoCard(makeTodo({ updatedAt: threeDaysAgo }));
    expect(html).toContain("updated 3d ago");
  });

  it("wraps a long title across lines instead of truncating to one line", () => {
    const html = todoCard(makeTodo({ title: "A very long issue title that should wrap across more than one line of text" }));
    expect(html).toContain("A very long issue title that should wrap across more than one line of text");
    expect(html).not.toContain("text-overflow:ellipsis");
    expect(html).not.toContain("-webkit-line-clamp");
  });

  it("the number pill is the card's only anchor (the card is no longer one big <a>)", () => {
    const html = todoCard(makeTodo({ summary: "prose", milestone: { title: "M", dueOn: null }, nextStep: "do it" }));
    expect((html.match(/<a /g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/^<a /);
  });

  it("renders displayTitle when set, falling back to the raw title when null", () => {
    const humanized = todoCard(makeTodo({ displayTitle: "Chase down the flaky test" }));
    expect(humanized).toContain("Chase down the flaky test");
    expect(humanized).not.toContain("Investigate flaky test");
    const fallback = todoCard(makeTodo({ displayTitle: null }));
    expect(fallback).toContain("Investigate flaky test");
  });

  it("renders a Milestone row with the title and a '· due <date>' suffix when dueOn is set", () => {
    const html = todoCard(makeTodo({ milestone: { title: "Reliable event capture", dueOn: "2026-07-20" } }));
    expect(html).toContain("Milestone");
    expect(html).toContain("Reliable event capture");
    expect(html).toContain("· due Jul 20");
  });

  it("omits the due suffix when dueOn is null; collapses the whole row when milestone is null", () => {
    const noDue = todoCard(makeTodo({ milestone: { title: "Reliable event capture", dueOn: null } }));
    expect(noDue).toContain("Milestone");
    expect(noDue).not.toContain("· due");
    const noMilestone = todoCard(makeTodo({ milestone: null }));
    expect(noMilestone).not.toContain("Milestone");
  });

  it("renders a Next step row (accent label) when set; collapses it when null", () => {
    const withStep = todoCard(makeTodo({ nextStep: "Add a per-ref delivery lock." }));
    expect(withStep).toContain("Next step");
    expect(withStep).toContain("Add a per-ref delivery lock.");
    expect(withStep).toContain('color:var(--accent)">Next step');
    const withoutStep = todoCard(makeTodo({ nextStep: null }));
    expect(withoutStep).not.toContain("Next step");
  });

  it("styles backtick spans in prose bodies as <code> after escaping (no raw HTML injection)", () => {
    const html = todoCard(makeTodo({ nextStep: "Add a lock in `consumer.ts` before the write.", summary: "A `<b>tag</b>` inside code." }));
    expect(html).toContain(">consumer.ts</code>");
    expect(html).toContain("&lt;b&gt;tag&lt;/b&gt;"); // escaped BEFORE the code-span pass
    expect(html).not.toContain("<b>tag</b>");
  });
});

// ── full render() — My Work screen composition ──────────────────────────────

describe("render() — My Work screen", () => {
  function stateWithDashboard(data: DashboardData, admin = false): ReturnType<typeof initialState> {
    const s = initialState();
    return {
      ...s,
      view: "app",
      screen: "mywork",
      me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin },
      mywork: { status: "ok", data },
    };
  }

  // previousActivity items here use summary:null (linkifyRefs fallback path) — myWorkView
  // passes the REAL renderMarkdown (DOMPurify) for non-null summaries, and DOMPurify needs
  // DOM globals that aren't present in this workerd test environment (same reason
  // render.triage.test.ts never drives renderMarkdown through the full render() tree).
  it("contains both section labels", () => {
    const data: DashboardData = {
      person: "alice",
      previousActivity: [makePr({ summary: null })],
      todo: [makeTodo()],
      degraded: false,
    };
    const html = render(stateWithDashboard(data));
    expect(html).toContain("Previous activity");
    expect(html).toContain("To-do");
  });

  it("does NOT contain the old 'Working on now' focus headline (revert guard)", () => {
    const data: DashboardData = {
      person: "alice",
      previousActivity: [makePr({ summary: null })],
      todo: [makeTodo()],
      degraded: false,
    };
    const html = render(stateWithDashboard(data));
    expect(html).not.toContain("Working on now");
  });

  it("does NOT contain roadmap phase or feed remnants", () => {
    const data: DashboardData = {
      person: "alice",
      previousActivity: [],
      todo: [],
      degraded: false,
    };
    const html = render(stateWithDashboard(data));
    expect(html).not.toContain("From the roadmap");
    expect(html).not.toContain("Your recent activity");
  });

  it("empty lists show dashed-card hints, not crashes", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const html = render(stateWithDashboard(data));
    expect(html).toContain("Previous activity");
    expect(html).toContain("To-do");
  });

  it("degraded:true renders a degraded hint instead of a normal empty state", () => {
    const data: DashboardData = { person: null, previousActivity: [], todo: [], degraded: true };
    const html = render(stateWithDashboard(data));
    expect(html).toContain("Previous activity");
    expect(html).toContain("To-do");
  });

  // ── admin-only Sync GitHub button (server-side backfill trigger) ────────────
  it("renders the Sync GitHub backfill button for an admin me", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const html = render(stateWithDashboard(data, true));
    expect(html).toContain('data-act="adminBackfill"');
    expect(html).toContain("Sync GitHub");
  });

  it("does NOT render the Sync GitHub button for a non-admin me", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const html = render(stateWithDashboard(data, false));
    expect(html).not.toContain('data-act="adminBackfill"');
  });

  it("shows a disabled Sync button while backfillSync is set", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "progress", prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } as const };
    const html = render(s);
    expect(html).toContain("disabled");
    expect(html).toContain("Syncing");
    expect(html).not.toContain("Sync GitHub");
  });

  it("renders two progress bars — PRs and issues — while backfillSync is in progress", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "progress", prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } as const };
    const html = render(s);
    expect(html).toContain("66 of 146 PRs summarized");
    expect(html).toContain("width:45%"); // Math.round(66/146*100)
    expect(html).toContain("3 of 10 issues summarized");
    expect(html).toContain("width:30%"); // Math.round(3/10*100)
  });

  it("renders an inventory-taking line — never '0 of 0' bars — while the first batch is in flight", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "starting" } as const };
    const html = render(s);
    expect(html).toContain("Syncing GitHub");
    expect(html).toContain("Contacting GitHub");
    expect(html).not.toContain("0 of 0");
  });

  it("renders no progress modal when backfillSync is null", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const html = render(stateWithDashboard(data, true));
    expect(html).not.toContain("Syncing GitHub");
  });

  it("renders the stored summary on a todo card when one exists", () => {
    const html = todoCard(makeTodo({ summary: "Fix the OAuth consent fallback on Edge." }));
    expect(html).toContain("Summary");
    expect(html).toContain("Fix the OAuth consent fallback on Edge.");
  });

  it("renders no Summary row on a todo card without a summary (null rows collapse)", () => {
    const html = todoCard(makeTodo({ summary: null }));
    expect(html).not.toContain("Summary");
  });

  it("renders To-do before Previous activity", () => {
    const data: DashboardData = {
      person: "alice",
      previousActivity: [makePr({ summary: null })],
      todo: [makeTodo()],
      degraded: false,
    };
    const html = render(stateWithDashboard(data));
    expect(html.indexOf("To-do")).toBeLessThan(html.indexOf("Previous activity"));
  });
});
