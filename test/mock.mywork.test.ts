/**
 * TEMPORARY design-preview mock layer tests (web/src/mock.ts) — delete this
 * file together with mock.ts when the structured-summary backend lands.
 *
 * Verifies the decoration contract:
 *  • real items — only-null fields are filled; non-null values are never
 *    overwritten; displayTitle stays null (render falls back to the raw title)
 *  • empty lists — the canonical wireframe cards (#142 issue / #138 PR) are
 *    injected, and the PR summary parses as the structured What changed/Why form
 *  • purity — the input DashboardData is never mutated
 *
 * All tests are pure (no D1 / Miniflare bindings), mirroring
 * test/render.mywork.test.ts's builder pattern.
 */
import { describe, it, expect } from "vitest";
import { MYWORK_MOCKS_ENABLED, applyMyWorkMocks } from "../web/src/mock";
import { parseStructuredSummary } from "@shared/prSummary";
import type { MyWorkPr, MyWorkTodo, DashboardData } from "@shared/dashboard";

// ── helpers (same builders as render.mywork.test.ts) ─────────────────────────

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
    labels: ["bug", "flaky", "ci"],
    url: "https://github.com/SaplingLearn/sapling/issues/7",
    updatedAt: new Date().toISOString(),
    summary: null,
    milestone: null,
    nextStep: null,
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    person: "alice",
    previousActivity: [makePr()],
    todo: [makeTodo()],
    degraded: false,
    ...overrides,
  };
}

// ── the flag ──────────────────────────────────────────────────────────────────

it("MYWORK_MOCKS_ENABLED is on while the design preview ships", () => {
  expect(MYWORK_MOCKS_ENABLED).toBe(true);
});

// ── real items: fill only-null fields ─────────────────────────────────────────

describe("applyMyWorkMocks — real items", () => {
  it("fills null milestone + nextStep on a real todo, leaving displayTitle null", () => {
    const out = applyMyWorkMocks(makeDashboard());
    const t = out.todo[0];
    expect(t.milestone).toEqual({ title: "Reliable event capture", dueOn: "2026-07-20" });
    expect(t.nextStep).toContain("per-ref delivery lock");
    expect(t.displayTitle).toBeNull(); // render falls back to the real title
    expect(t.number).toBe(7); // still the real item, not an injected card
  });

  it("fills null impact + baseRef on a real PR, leaving displayTitle null", () => {
    const out = applyMyWorkMocks(makeDashboard());
    const pr = out.previousActivity[0];
    expect(pr.impact).toContain("Issue summaries now show up");
    expect(pr.baseRef).toBe("main");
    expect(pr.displayTitle).toBeNull();
    expect(pr.number).toBe(42);
    expect(pr.summary).toBe("Fixed **the thing** that was broken."); // real summary untouched
  });

  it("never overwrites non-null values", () => {
    const todo = makeTodo({ milestone: { title: "Real milestone", dueOn: null }, nextStep: "Real next step." });
    const pr = makePr({ impact: "Real impact.", baseRef: "release/1.x" });
    const out = applyMyWorkMocks(makeDashboard({ todo: [todo], previousActivity: [pr] }));
    expect(out.todo[0].milestone).toEqual({ title: "Real milestone", dueOn: null });
    expect(out.todo[0].nextStep).toBe("Real next step.");
    expect(out.previousActivity[0].impact).toBe("Real impact.");
    expect(out.previousActivity[0].baseRef).toBe("release/1.x");
  });
});

// ── empty lists: inject the canonical wireframe cards ─────────────────────────

describe("applyMyWorkMocks — empty lists", () => {
  it("injects the canonical #142 todo card when todo is empty", () => {
    const out = applyMyWorkMocks(makeDashboard({ todo: [] }));
    expect(out.todo).toHaveLength(1);
    const t = out.todo[0];
    expect(t.number).toBe(142);
    expect(t.title).toBe("Reconcile drops events when webhook retries overlap");
    expect(t.displayTitle).toBe("Reconcile drops events when webhook retries overlap");
    expect(t.priority).toBe("P1");
    expect(t.labels).toEqual(["bug", "consumer", "webhook"]);
    expect(t.url).toBe("https://github.com/SaplingLearn/sapling/issues/142");
    expect(t.summary).toContain("Overlapping webhook redeliveries");
    expect(t.milestone).toEqual({ title: "Reliable event capture", dueOn: "2026-07-20" });
    expect(t.nextStep).toContain("`consumer.ts`");
    // updatedAt ≈ 5 hours ago
    const ageMs = Date.now() - new Date(t.updatedAt).getTime();
    expect(ageMs).toBeGreaterThan(4.9 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(5.1 * 60 * 60 * 1000);
  });

  it("injects the canonical #138 PR card when previousActivity is empty", () => {
    const out = applyMyWorkMocks(makeDashboard({ previousActivity: [] }));
    expect(out.previousActivity).toHaveLength(1);
    const pr = out.previousActivity[0];
    expect(pr.number).toBe(138);
    expect(pr.title).toBe("Route issue summaries through the summarizer queue");
    expect(pr.displayTitle).toBe("Route issue summaries through the summarizer queue");
    expect(pr.merged).toBe(true);
    expect(pr.url).toBe("https://github.com/SaplingLearn/sapling/pull/138");
    expect(pr.impact).toContain("Issue summaries now show up");
    expect(pr.baseRef).toBe("main");
    // occurredAt ≈ 2 days ago
    const ageMs = Date.now() - new Date(pr.occurredAt).getTime();
    expect(ageMs).toBeGreaterThan(47.9 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(48.1 * 60 * 60 * 1000);
  });

  it("the injected PR summary parses as the structured What changed/Why convention", () => {
    const out = applyMyWorkMocks(makeDashboard({ previousActivity: [] }));
    const structured = parseStructuredSummary(out.previousActivity[0].summary!);
    expect(structured).not.toBeNull();
    expect(structured!.what).toContain("enqueue a summarize job");
    expect(structured!.why).toContain("blocked webhook ACKs");
  });

  it("does not inject when a list already has items", () => {
    const out = applyMyWorkMocks(makeDashboard());
    expect(out.todo.map((t) => t.number)).toEqual([7]);
    expect(out.previousActivity.map((pr) => pr.number)).toEqual([42]);
  });
});

// ── purity ────────────────────────────────────────────────────────────────────

describe("applyMyWorkMocks — purity", () => {
  it("never mutates the input (real items, empty lists, person, degraded)", () => {
    const input = makeDashboard({ person: null, previousActivity: [] });
    const snapshot = structuredClone(input);
    const out = applyMyWorkMocks(input);
    expect(input).toEqual(snapshot); // input untouched, deep
    expect(out).not.toBe(input);
    expect(out.todo[0]).not.toBe(input.todo[0]); // decorated items are copies
    expect(out.person).toBeNull(); // person passes through — myWorkView never reads it
    expect(out.degraded).toBe(false);
  });
});
