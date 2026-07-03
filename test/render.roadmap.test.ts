/**
 * Task 15 render tests — Roadmap screen rebuild (admin narrative + cached progress).
 *
 * Tests pure helper functions exported from web/src/render.ts:
 *  • planNarrativeBlock — the ADMIN-authored plan narrative rendered via an injected
 *    markdown fn (mirrors renderProposalContent's pattern); empty → dashed-card hint.
 *  • render() over a roadmap-populated AppState — narrative tab shows the narrative,
 *    timeline tab shows cached progress ("4/6 closed"), phase mono suffix, and the
 *    Confirm-done button; search results of type "milestone" navigate via goRoadmap.
 *
 * All tests are pure (no D1 / Miniflare bindings) and assertions are HTML-string based.
 * The module-level renderMarkdown (marked + DOMPurify) cannot run in this workerd test
 * environment (DOMPurify needs DOM globals — same reason render.triage.test.ts and
 * render.mywork.test.ts never drive it), so the markdown module is vi.mock'd with an
 * ESCAPING mock: anything that appears inside the mock wrapper provably went through
 * the markdown fn (the XSS discipline under test), never raw interpolation.
 */
import { describe, it, expect, vi } from "vitest";

// Hoisted above the render.ts import — full render() trees use this mock in place of
// the real marked+DOMPurify pipeline. It escapes its input so the "was the markdown fn
// what produced the output?" assertion is direct: raw <script> can never survive it.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) =>
    `<div class="mock-live-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
}));

import { planNarrativeBlock, render, initialState } from "../web/src/render";
import type { PlanView, MilestoneWithProgress } from "../web/src/api";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Mock markdown function for direct planNarrativeBlock calls (pattern: render.triage.test.ts). */
const mockMd = (body: string) => `<div class="mock-md">${body}</div>`;

/** Escaping mock — mirrors what a sanitizer does, for the XSS assertions. */
const escMockMd = (body: string) =>
  `<div class="mock-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;

function makeMilestone(overrides: Partial<MilestoneWithProgress> = {}): MilestoneWithProgress {
  return {
    id: 1,
    title: "Vectorize GA",
    description: "Ship semantic search to everyone.",
    target_date: "2026-09-01",
    status: "in_progress",
    github_ref: null,
    created_at: "2026-07-01T00:00:00Z",
    created_by: "admin",
    updated_at: null,
    phase: null,
    progress: { closed: 4, total: 6, computed_at: "2026-07-02T00:00:00Z" },
    ...overrides,
  };
}

function makePlanView(overrides: Partial<PlanView> = {}): PlanView {
  return {
    narrative: "The plan **narrative** prose.",
    version: 3,
    updated_at: "2026-07-02T00:00:00Z",
    updated_by: "admin",
    milestones: [makeMilestone()],
    ...overrides,
  };
}

function stateWithPlan(plan: PlanView, tab: "narrative" | "timeline"): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "roadmap",
    roadmapTab: tab,
    me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin: false },
    roadmap: { status: "ok", data: plan },
  };
}

// ── planNarrativeBlock ────────────────────────────────────────────────────────

describe("planNarrativeBlock", () => {
  it("renders the narrative through the injected markdown fn inside a cnpy-md wrapper", () => {
    const html = planNarrativeBlock("Some **plan** prose.", mockMd);
    expect(html).toContain("mock-md");
    expect(html).toContain("Some **plan** prose.");
    expect(html).toContain('class="cnpy-md"');
  });

  it("empty narrative → dashed-card hint, no markdown wrapper", () => {
    const html = planNarrativeBlock("", mockMd);
    expect(html).toContain("No plan narrative yet — write one with the update-plan skill");
    expect(html).not.toContain("mock-md");
    expect(html).not.toContain("cnpy-md");
    expect(html).toContain("dashed");
  });

  it("whitespace-only narrative also falls back to the hint", () => {
    const html = planNarrativeBlock("   \n  ", mockMd);
    expect(html).toContain("No plan narrative yet");
    expect(html).not.toContain("mock-md");
  });

  it("XSS: the narrative goes ONLY through markdownFn — an escaping mock leaves no raw <script>", () => {
    const html = planNarrativeBlock('<script>alert(1)</script>', escMockMd);
    // The mock fn is what produced the output (its wrapper is present)…
    expect(html).toContain("mock-md");
    // …and the raw payload never appears unescaped anywhere in the block.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── full render() — narrative tab ────────────────────────────────────────────

describe("render() — Roadmap narrative tab", () => {
  it("opens with the admin narrative rendered via the markdown module", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain("mock-live-md");
    expect(html).toContain("The plan **narrative** prose.");
  });

  it("keeps the milestone spotlight and Recent happenings sections below the narrative", () => {
    const html = render(stateWithPlan(makePlanView(), "narrative"));
    expect(html).toContain(">NOW<"); // spotlight badge for the in-progress milestone
    expect(html).toContain("Vectorize GA");
    expect(html).toContain("Recent happenings");
    // Narrative block precedes the spotlight
    expect(html.indexOf("mock-live-md")).toBeLessThan(html.indexOf(">NOW<"));
  });

  it("empty narrative → the update-plan hint in the narrative tab", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: "" }), "narrative"));
    expect(html).toContain("No plan narrative yet — write one with the update-plan skill");
    expect(html).not.toContain("mock-live-md");
  });

  it("XSS: a <script> narrative reaches the DOM only via the (sanitizing) markdown module", () => {
    const html = render(stateWithPlan(makePlanView({ narrative: '<script>alert(1)</script>' }), "narrative"));
    expect(html).toContain("mock-live-md"); // the markdown fn produced the output
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── full render() — timeline tab ─────────────────────────────────────────────

describe("render() — Roadmap timeline tab", () => {
  it("shows cached progress as 4/6 closed (no live GitHub)", () => {
    const html = render(stateWithPlan(makePlanView(), "timeline"));
    expect(html).toContain("4/6 closed");
  });

  it("shows the phase as a small mono suffix before the date label, · separated", () => {
    const plan = makePlanView({ milestones: [makeMilestone({ phase: "Phase 2 — reads" })] });
    const html = render(stateWithPlan(plan, "timeline"));
    expect(html).toContain("Phase 2 — reads · ");
    // Date label is kept alongside the phase (target 2026-09-01 → "Sep 1, 2026")
    expect(html).toContain("Sep 1, 2026");
  });

  it("omits the phase suffix when phase is null", () => {
    const html = render(stateWithPlan(makePlanView(), "timeline"));
    expect(html).not.toContain("null · ");
    expect(html).toContain("Sep 1, 2026");
  });

  it("XSS: a malicious phase is escaped", () => {
    const plan = makePlanView({ milestones: [makeMilestone({ phase: '<img src=x onerror=alert(1)>' })] });
    const html = render(stateWithPlan(plan, "timeline"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("keeps the Confirm-done button for a ready milestone (all issues closed, not done)", () => {
    const ready = makeMilestone({ id: 9, title: "All wrapped", progress: { closed: 6, total: 6, computed_at: "2026-07-02T00:00:00Z" } });
    const html = render(stateWithPlan(makePlanView({ milestones: [ready] }), "timeline"));
    expect(html).toContain('data-act="confirmMilestone"');
    expect(html).toContain('data-arg="9"');
    expect(html).toContain("Confirm done");
  });
});

// ── search results — milestone type navigates to the Roadmap screen ──────────

describe("search results — milestone hits navigate via goRoadmap", () => {
  it("a milestone-typed primary result renders as a goRoadmap button", () => {
    const s = initialState();
    const html = render({
      ...s,
      view: "app",
      screen: "search",
      me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin: false },
      searchResults: {
        status: "ok",
        data: {
          primary: [{
            type: "milestone", id: "1", title: "Vectorize GA",
            section: null, space: null, body: "Ship semantic search.",
            authority: "live", current_version: null, pending_version: null,
            staged_body: null, confidence: null,
            updated_at: null, updated_by: null, score: 1,
          }],
          pointers: [],
          meta: { engine: "fts5", total: 1 },
        },
      },
    });
    expect(html).toContain('data-act="goRoadmap"');
  });

  it("a milestone-typed pointer result also gets the goRoadmap action", () => {
    const s = initialState();
    const html = render({
      ...s,
      view: "app",
      screen: "search",
      me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin: false },
      searchResults: {
        status: "ok",
        data: {
          primary: [],
          pointers: [{ type: "milestone", id: "2", title: "Plan hit", snippet: "…", authority: "live", score: 1 }],
          meta: { engine: "fts5", total: 1 },
        },
      },
    });
    expect(html).toContain('data-act="goRoadmap"');
  });
});
