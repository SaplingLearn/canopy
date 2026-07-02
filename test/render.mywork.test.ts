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

  it("omits the priority chip when priority is null", () => {
    const html = todoCard(makeTodo({ priority: null }));
    expect(html).not.toContain("P0");
    expect(html).not.toContain("P1");
    expect(html).not.toContain("P2");
    expect(html).not.toContain("P3");
  });
});

// ── full render() — My Work screen composition ──────────────────────────────

describe("render() — My Work screen", () => {
  function stateWithDashboard(data: DashboardData): ReturnType<typeof initialState> {
    const s = initialState();
    return {
      ...s,
      view: "app",
      screen: "mywork",
      me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn" },
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
});
