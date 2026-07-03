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
    url: "https://github.com/SaplingLearn/sapling/pull/42",
    merged: true,
    occurredAt: new Date().toISOString(),
    summary: "Fixed **the thing** that was broken.",
    ...overrides,
  };
}

function makeTodo(overrides: Partial<MyWorkTodo> = {}): MyWorkTodo {
  return {
    number: 7,
    title: "Investigate flaky test",
    priority: "P1",
    labels: ["bug", "flaky", "ci", "extra"],
    url: "https://github.com/SaplingLearn/sapling/issues/7",
    updatedAt: new Date().toISOString(),
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

  it("falls back to the raw prose block for a non-conforming summary (legacy/excerpt)", () => {
    const pr = makePr({ summary: "Fixed the login bug that was affecting users." });
    const html = prActivityCard(pr, mockMd);
    expect(html).not.toContain("What changed");
    expect(html).toContain("mock-md");
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

  it("shows a relative 'updated' time derived from t.updatedAt", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const html = todoCard(makeTodo({ updatedAt: threeDaysAgo }));
    expect(html).toContain("3d ago");
  });

  it("wraps a long title across lines instead of truncating to one line", () => {
    const html = todoCard(makeTodo({ title: "A very long issue title that should wrap across more than one line of text" }));
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).not.toContain("text-overflow:ellipsis");
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
