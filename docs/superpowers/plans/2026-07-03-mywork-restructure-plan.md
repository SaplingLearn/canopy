# My Work Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder My Work so To-do renders above Previous activity, give both sections
richer structured cards, and make the admin "Sync GitHub" backfill retroactively
migrate every historical merged PR (not just brand-new ones) to the new structured
summary format.

**Architecture:** A new shared module (`shared/prSummary.ts`) defines a markdown
convention (`**What changed:** ... **Why:** ...`) and a parser for it — the single
source of truth both the Worker (to decide whether a PR summary needs regenerating)
and the web build (to decide how to render it) import. No database migration: the
structure lives in the markdown convention inside the existing `pr_summaries.summary`
TEXT column, so old prose and the deterministic excerpt fallback degrade gracefully to
today's plain rendering instead of erroring.

**Tech Stack:** TypeScript, Cloudflare Workers (Hono), D1, Vitest + Miniflare, plain
DOM-less server-rendered HTML strings (`web/src/render.ts`).

## Global Constraints

- Design source: `docs/superpowers/specs/2026-07-03-mywork-restructure-design.md`.
- No new D1 migration — `pr_summaries.summary` stays a single `TEXT` column.
- `shared/` is the only cross-layer import location (`@shared/...` alias) — new shared
  logic goes there, never duplicated in `src/` and `web/` separately.
- Backend tests run against real Miniflare D1 (`npx vitest run test/<file>.test.ts`);
  GitHub I/O and the summarizer are dependency-injected (`fetchImpl`, `summarizer`) —
  never hit the network in tests.
- Frontend render tests are pure (no DOM/DOMPurify) — mirror the existing `mockMd`
  pattern in `test/render.mywork.test.ts`.
- Run `npm run typecheck` after any task touching `shared/` or crossing the
  Worker/web boundary — it does not run as part of `npm test`.

---

### Task 1: Shared structured-summary parser

**Files:**
- Create: `shared/prSummary.ts`
- Create: `test/prSummary.test.ts`

**Interfaces:**
- Produces: `interface StructuredPrSummary { what: string; why: string | null }` and
  `function parseStructuredSummary(raw: string): StructuredPrSummary | null`, imported
  as `@shared/prSummary` by Task 3 (frontend rendering) and Task 5 (backend backfill
  skip-check).

- [ ] **Step 1: Write the failing tests**

Create `test/prSummary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseStructuredSummary } from "@shared/prSummary";

describe("parseStructuredSummary", () => {
  it("parses What changed + Why into separate fields", () => {
    const raw = "**What changed:** Fixed the login bug.\n**Why:** Users were being logged out unexpectedly.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were being logged out unexpectedly.",
    });
  });

  it("parses What changed alone, why:null, when there is no Why line", () => {
    const raw = "**What changed:** Fixed the login bug.";
    expect(parseStructuredSummary(raw)).toEqual({ what: "Fixed the login bug.", why: null });
  });

  it("handles What changed and Why on the same line", () => {
    const raw = "**What changed:** Fixed the login bug. **Why:** Users were affected.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were affected.",
    });
  });

  it("is case-insensitive on the labels", () => {
    const raw = "**what changed:** Fixed the login bug.\n**why:** Users were affected.";
    expect(parseStructuredSummary(raw)).toEqual({
      what: "Fixed the login bug.",
      why: "Users were affected.",
    });
  });

  it("returns null for old-style prose with no convention", () => {
    expect(parseStructuredSummary("Fixed a bug that was breaking the login flow.")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseStructuredSummary("")).toBeNull();
  });

  it("returns null when the What field is empty even if a Why is present", () => {
    const raw = "**What changed:** \n**Why:** something";
    expect(parseStructuredSummary(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/prSummary.test.ts`
Expected: FAIL — `@shared/prSummary` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `shared/prSummary.ts`:

```ts
// Recognizes the "What changed / Why" markdown convention emitted by the PR
// summarizer (src/tools/summarize.ts) so both the Worker (the backfill's
// already-structured check, src/tools/backfill.ts) and the web build (card
// rendering, web/src/render.ts) agree on what counts as a structured summary.
// No schema change backs this — pr_summaries.summary stays a single markdown
// TEXT column; the structure lives in this convention, not a stored shape, so
// old prose summaries and the deterministic excerpt fallback degrade
// gracefully to a `null` parse instead of erroring.

export interface StructuredPrSummary {
  what: string;
  why: string | null;
}

const STRUCTURED_RE = /^\s*\*\*What changed:\*\*\s*([\s\S]*?)(?:\s*\*\*Why:\*\*\s*([\s\S]*))?$/i;

/** Parses "**What changed:** ... **Why:** ..." out of a PR summary's markdown.
 *  Returns null when the text doesn't match (old-style prose, the excerpt
 *  fallback, or a malformed AI response) — callers treat null as "render/treat
 *  as plain prose," never as an error. */
export function parseStructuredSummary(raw: string): StructuredPrSummary | null {
  const m = raw.match(STRUCTURED_RE);
  if (!m) return null;
  const what = m[1].trim();
  if (!what) return null;
  const why = m[2]?.trim() || null;
  return { what, why };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/prSummary.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add shared/prSummary.ts test/prSummary.test.ts
git commit -m "feat(shared): parseStructuredSummary — What changed/Why markdown convention"
```

---

### Task 2: Backend — structured summarizer prompt

**Files:**
- Modify: `src/tools/summarize.ts:16-45`
- Modify: `test/summarize.test.ts:1-11` (import), append a new `describe` block

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `SUMMARIZER_SYSTEM_PROMPT` constant (the two-field shape it
  requires is what Task 1's `parseStructuredSummary` recognizes — keep them in sync
  if either changes). `workersAiSummarizer`'s exported signature is unchanged.

- [ ] **Step 1: Write the failing test**

In `test/summarize.test.ts`, change the import on line 7 from:

```ts
import { storePrSummary, excerptSummary } from "../src/tools/summarize";
```

to:

```ts
import { storePrSummary, excerptSummary, SUMMARIZER_SYSTEM_PROMPT } from "../src/tools/summarize";
```

Then append this block at the end of the file (after the `webhook → summarize wiring`
`describe` block):

```ts
describe("SUMMARIZER_SYSTEM_PROMPT", () => {
  it("requires the structured What changed / Why convention", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("**What changed:**");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("**Why:**");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/summarize.test.ts`
Expected: FAIL — `SUMMARIZER_SYSTEM_PROMPT` is not exported yet.

- [ ] **Step 3: Write the implementation**

In `src/tools/summarize.ts`, replace lines 16-45 (from `const WORKERS_AI_MODEL = ...`
through the end of `workersAiSummarizer`) with:

```ts
const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Exported for a content assertion in test/summarize.test.ts — the two-field
// shape here is exactly what shared/prSummary.ts's parseStructuredSummary
// recognizes; keep them in sync if either changes.
export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this one pull request's description for a team activity feed. " +
  "Respond with ONLY this exact markdown structure, nothing else:\n" +
  "**What changed:** <1-2 short factual sentences>\n" +
  "**Why:** <1 short sentence stating the description's own stated rationale>\n" +
  'If the description states no rationale, omit the "**Why:**" line entirely. ' +
  "Do not speculate beyond the text.";

/** Workers AI-backed summarizer. Bounded to THAT PR's own title+body — no other
 *  context is sent. Never throws: any failure (network, empty output, malformed
 *  response) resolves to null so the caller falls back to excerptSummary. */
export function workersAiSummarizer(ai: Ai): Summarizer {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      try {
        const result = await ai.run(WORKERS_AI_MODEL, {
          messages: [
            { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
            { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
          ],
        });
        const response = (result as { response?: unknown } | null)?.response;
        if (typeof response !== "string") return null;
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/summarize.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add src/tools/summarize.ts test/summarize.test.ts
git commit -m "feat(summarize): require the What changed/Why structured markdown convention"
```

---

### Task 3: Frontend — structured "Previous activity" cards

**Files:**
- Modify: `web/src/render.ts:10` (import), `:1331` (label style), `:1354-1375`
  (`prActivityCard`)
- Modify: `test/render.mywork.test.ts` — append cases to the `prActivityCard`
  `describe` block

**Interfaces:**
- Consumes: `parseStructuredSummary`, `StructuredPrSummary` from `@shared/prSummary`
  (Task 1).
- Produces: `prActivityCard`'s exported signature is unchanged
  (`(pr: MyWorkPr, markdownFn: (body: string) => string) => string`) — only its
  internal rendering changes, so no other file needs to change its call site.

- [ ] **Step 1: Write the failing tests**

In `test/render.mywork.test.ts`, inside the existing `describe("prActivityCard", ...)`
block, append these three tests (after the last existing `it(...)`, before the
block's closing `});`):

```ts
  it("renders structured What changed + Why as separate labeled rows", () => {
    const pr = makePr({ summary: "**What changed:** Fixed the login bug.\n**Why:** Users were logged out unexpectedly." });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("What changed");
    expect(html).toContain("Why");
    expect(html).toContain("Fixed the login bug.");
    expect(html).toContain("Users were logged out unexpectedly.");
  });

  it("omits the Why row when the structured summary has no Why", () => {
    const pr = makePr({ summary: "**What changed:** Fixed the login bug." });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("What changed");
    expect(html).not.toContain("Why");
  });

  it("falls back to the raw prose block for a non-conforming summary (legacy/excerpt)", () => {
    const pr = makePr({ summary: "Fixed the login bug that was affecting users." });
    const html = prActivityCard(pr, mockMd);
    expect(html).not.toContain("What changed");
    expect(html).toContain("mock-md");
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: the 3 new tests FAIL (current `prActivityCard` always renders the raw
prose block, never labeled rows); all pre-existing tests in the file still PASS.

- [ ] **Step 3: Write the implementation**

In `web/src/render.ts`, change the import block. Line 10 currently reads:

```ts
import type { DashboardData, MyWorkPr, MyWorkTodo } from "@shared/dashboard";
```

Add a new line directly after it:

```ts
import type { DashboardData, MyWorkPr, MyWorkTodo } from "@shared/dashboard";
import { parseStructuredSummary, type StructuredPrSummary } from "@shared/prSummary";
```

Then, at line 1331, directly after the `MW_LABEL` constant, add:

```ts
const MW_LABEL = "font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)";
const MW_FIELD_LABEL = "font-size:10px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40);margin-bottom:3px";
```

Then replace the whole `prActivityCard` function (lines 1354-1375, from the
`/** A merged/closed PR card...` comment through its closing `}`) with:

```ts
/** Renders a structured {what, why} summary as labeled rows (small caption + markdown body each). */
function structuredSummaryBody(structured: StructuredPrSummary, markdownFn: (body: string) => string): string {
  const whatRow = `<div${structured.why ? ' style="margin-bottom:10px"' : ""}>
      <div style="${MW_FIELD_LABEL}">What changed</div>
      <div class="cnpy-md" style="font-size:13.5px;color:var(--fg-70)">${markdownFn(structured.what)}</div>
    </div>`;
  const whyRow = structured.why
    ? `<div>
      <div style="${MW_FIELD_LABEL}">Why</div>
      <div class="cnpy-md" style="font-size:13.5px;color:var(--fg-70)">${markdownFn(structured.why)}</div>
    </div>`
    : "";
  return whatRow + whyRow;
}

/** A merged/closed PR card: #number → pr.url, title, relTime, MERGED/CLOSED chip,
 *  and a summary body — labeled "What changed"/"Why" rows when pr.summary matches
 *  the structured convention, else the raw markdown blob (legacy/excerpt fallback). */
export function prActivityCard(pr: MyWorkPr, markdownFn: (body: string) => string): string {
  const chip = pr.merged
    ? `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--green);border:1px solid color-mix(in srgb,var(--green) 45%,transparent);background:color-mix(in srgb,var(--green) 12%,transparent);border-radius:5px;padding:2px 6px;white-space:nowrap">MERGED</span>`
    : `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap">CLOSED</span>`;
  const structured = pr.summary !== null ? parseStructuredSummary(pr.summary) : null;
  const body = pr.summary === null
    ? `<div style="font-size:13.5px;color:var(--fg-55);line-height:1.6">${linkifyRefs("No summary recorded for this PR.")}</div>`
    : structured !== null
      ? structuredSummaryBody(structured, markdownFn)
      : `<div class="cnpy-md" style="font-size:13.5px;color:var(--fg-70)">${markdownFn(pr.summary)}</div>`;
  return `<div class="cnpy-card" style="border:1px solid var(--border);border-radius:13px;padding:14px 16px;margin-bottom:10px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:9px;min-width:0">
        <a href="${attr(safeUrl(pr.url))}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:12px;color:var(--fg-40);text-decoration:none;flex:none">#${pr.number}</a>
        <span style="font-size:14px;font-weight:500;color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pr.title)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:9px;flex:none">
        ${chip}
        <span style="font-size:11.5px;color:var(--fg-40)">${relTime(pr.occurredAt)}</span>
      </div>
    </div>
    ${body}
  </div>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: PASS (all tests, including the 3 new ones and every pre-existing one —
the default `makePr()` summary "Fixed **the thing** that was broken." doesn't match
the structured convention, so it still falls into the prose-block path unchanged).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts test/render.mywork.test.ts
git commit -m "feat(mywork): render structured What changed/Why PR summaries as labeled rows"
```

---

### Task 4: Frontend — To-do card restructure + reorder

**Files:**
- Modify: `web/src/render.ts:1377-1387` (`todoCard`), `:1413-1416` (`myWorkView`
  composition order)
- Modify: `test/render.mywork.test.ts` — append cases to the `todoCard` and
  `render() — My Work screen` `describe` blocks

**Interfaces:**
- Consumes: existing `relTime` helper (already in scope in `render.ts`).
- Produces: `todoCard`'s exported signature is unchanged (`(t: MyWorkTodo) => string`).

- [ ] **Step 1: Write the failing tests**

In `test/render.mywork.test.ts`, inside `describe("todoCard", ...)`, append (after
the last existing `it(...)`, before the block's closing `});`):

```ts
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
```

Inside `describe("render() — My Work screen", ...)`, append (after the last existing
`it(...)`, before the block's closing `});`):

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: the 3 new tests FAIL (current `todoCard` has no updated-at and truncates
via `white-space:nowrap`/`text-overflow:ellipsis`; `myWorkView` renders activity
before todo). Pre-existing tests still PASS.

- [ ] **Step 3: Write the implementation**

In `web/src/render.ts`, replace `todoCard` (lines 1377-1387) with:

```ts
/** An assigned-issue card — priority + #number + title (wraps up to 2 lines) on
 *  row 1, labels (capped at 3) + relative updated-at on row 2. No markdown. */
export function todoCard(t: MyWorkTodo): string {
  const prio = t.priority ? `<span style="font-size:10.5px;font-weight:700;font-family:var(--mono);color:var(--amber);flex:none">${esc(t.priority)}</span>` : "";
  const labels = t.labels.slice(0, 3).map((l) => `<span style="font-size:10.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px">${esc(l)}</span>`).join("");
  return `<a href="${attr(safeUrl(t.url))}" target="_blank" rel="noopener" class="cnpy-card" style="display:flex;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:10px;padding:11px 14px;text-decoration:none;color:var(--fg)">
    <div style="display:flex;align-items:baseline;gap:9px">
      ${prio}
      <span style="font-family:var(--mono);font-size:12px;color:var(--fg-40);flex:none">#${t.number}</span>
      <span style="font-size:13.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(t.title)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:5px">
      <span style="display:flex;gap:5px;flex:1;min-width:0">${labels}</span>
      <span style="font-size:11px;color:var(--fg-40);flex:none">${relTime(t.updatedAt)}</span>
    </div>
  </a>`;
}
```

Then, in `myWorkView`, change the composition (lines 1413-1416) from:

```ts
  const activity = mwSection("Previous activity", activityBody);
  const todo = mwSection("To-do", todoBody);

  return wrapMyWork(`${hero}${activity}${todo}`);
```

to:

```ts
  const activity = mwSection("Previous activity", activityBody);
  const todo = mwSection("To-do", todoBody);

  return wrapMyWork(`${hero}${todo}${activity}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/render.ts test/render.mywork.test.ts
git commit -m "feat(mywork): reorder To-do above Previous activity; richer To-do cards"
```

---

### Task 5: Backend — retroactive resync in Sync GitHub

**Files:**
- Modify: `src/tools/backfill.ts:1-6` (imports), `:22` (remove `DAYS_BACK`),
  `:24-31` (`BackfillResult`), `:120-219` (`runBackfill`)
- Modify: `test/backfill.test.ts` (full rewrite of fixtures/tests below)
- Modify: `web/src/api.ts:129` (`adminBackfill` return type)
- Modify: `web/src/main.ts:482-491` (`adminBackfill` flash message)
- Modify: `web/src/render.ts:342` (Sync GitHub button title text)

**Interfaces:**
- Consumes: `parseStructuredSummary` from `@shared/prSummary` (Task 1).
- Produces: `BackfillResult` gains `summarized: number`; `runBackfill`'s `opts` no
  longer accepts `now` (it had no purpose once the recency cutoff is removed).

- [ ] **Step 1: Rewrite the failing tests**

Replace the entire contents of `test/backfill.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/backfill.test.ts`
Expected: FAIL — `res.summarized` is `undefined` (not yet on `BackfillResult`); the
14-day-window assertion (`res.prs).toBe(2)`) also fails against current behavior.

- [ ] **Step 3: Write the implementation**

In `src/tools/backfill.ts`, replace the import block (lines 1-6) with:

```ts
import type { Env } from "../env";
import type { PrSummaryRow } from "@shared/rows";
import { first } from "../db";
import { ingestEvent } from "../consumer";
import { eventsFromDelivery } from "../webhook";
import { type Summarizer, workersAiSummarizer, storePrSummary } from "./summarize";
import { applyEventProgress } from "./progress";
import { parseStructuredSummary } from "@shared/prSummary";
```

Delete the `const DAYS_BACK = 14;` line (line 22).

Replace the `BackfillResult` interface (lines 24-31) with:

```ts
export interface BackfillResult {
  ok: boolean;
  error?: string;
  captured: number;
  unchanged: number;
  summarized: number;
  prs: number;
  issues: number;
}
```

Replace the function signature and early return (lines 120-129) with:

```ts
export async function runBackfill(
  env: Env,
  principalLogin: string,
  opts?: { fetchImpl?: typeof fetch; summarizer?: Summarizer | null }
): Promise<BackfillResult> {
  const token = env.GITHUB_SERVICE_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) {
    return { ok: false, error: "service token or repo not configured", captured: 0, unchanged: 0, summarized: 0, prs: 0, issues: 0 };
  }
```

Replace the fetch setup block (lines 131-139) — this removes the `cutoffMs` line:

```ts
  const doFetch = opts?.fetchImpl ?? fetch;
  const summarizer = opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: GH_API,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
```

Replace the PR list fetch (lines 141-160) with:

```ts
  // (a) All closed PRs, fully paginated — full history, not just recent
  //     activity, so a Sync also surfaces PRs merged before this route existed.
  const prList: GhPrListItem[] = [];
  {
    let url: string | null = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    while (url) {
      const res: Response = await doFetch(url, { headers });
      if (!res.ok) break;
      const page = (await res.json()) as GhPrListItem[];
      prList.push(...page);
      url = nextLink(res);
    }
  }
```

Replace the PR loop and its counters (lines 179-202) with:

```ts
  let captured = 0;
  let unchanged = 0;
  let summarized = 0;

  for (const pr of prList) {
    const payload = prClosedDelivery(pr);
    for (const base of eventsFromDelivery("pull_request", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(env.DB, ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
      } else {
        unchanged++;
      }

      // (Re)summarize unless it's already in the structured format — decoupled
      // from the event-capture outcome so a Sync also migrates PRs captured
      // before the structured format existed, not just brand-new ones.
      const existing = await first<PrSummaryRow>(
        env.DB,
        `SELECT summary FROM pr_summaries WHERE semantic_key = ?`,
        ev.semantic_key
      );
      const alreadyStructured = existing !== null && parseStructuredSummary(existing.summary) !== null;
      if (!alreadyStructured) {
        const parsed = JSON.parse(ev.raw) as { pr: { number: number; title: string; body: string | null } };
        await storePrSummary(env.DB, summarizer, {
          semantic_key: ev.semantic_key,
          pr_number: parsed.pr.number,
          title: parsed.pr.title,
          body: parsed.pr.body ?? "",
        });
        summarized++;
      }
    }
  }
```

Leave the issues loop (originally lines 204-217) exactly as-is — issues are never
summarized and already have no recency window.

Replace the final return (originally line 219) with:

```ts
  return { ok: true, captured, unchanged, summarized, prs: prList.length, issues: issueList.length };
```

Then wire `summarized` through the web layer. In `web/src/api.ts`, change line 129
from:

```ts
export function adminBackfill(): Promise<{ ok: boolean; captured: number; unchanged: number; prs: number; issues: number }> {
```

to:

```ts
export function adminBackfill(): Promise<{ ok: boolean; captured: number; unchanged: number; summarized: number; prs: number; issues: number }> {
```

In `web/src/main.ts`, change the `case "adminBackfill":` block (lines 482-491) from:

```ts
    case "adminBackfill": {
      flash("Syncing GitHub&hellip;");
      adminBackfill()
        .then((r) => { flash(`Synced: ${r.captured} captured, ${r.unchanged} unchanged`); loadMyWork(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Sync failed");
        });
      return;
    }
```

to:

```ts
    case "adminBackfill": {
      flash("Syncing GitHub&hellip;");
      adminBackfill()
        .then((r) => { flash(`Synced: ${r.captured} captured, ${r.unchanged} unchanged, ${r.summarized} summaries updated`); loadMyWork(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Sync failed");
        });
      return;
    }
```

In `web/src/render.ts`, on line 342, change:

```ts
    ? `<button data-act="adminBackfill" title="Fetch recent GitHub PRs + issues" class="cnpy-outlinebtn" style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">
```

to:

```ts
    ? `<button data-act="adminBackfill" title="Fetch all GitHub PRs + issues" class="cnpy-outlinebtn" style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/backfill.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/tools/backfill.ts test/backfill.test.ts web/src/api.ts web/src/main.ts web/src/render.ts
git commit -m "feat(backfill): retroactively resync PR summaries to the structured format; drop the 14-day window"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green, including `test/prSummary.test.ts`,
`test/summarize.test.ts`, `test/render.mywork.test.ts`, `test/backfill.test.ts`, and
every pre-existing suite untouched by this plan.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: no errors across `src/`, `web/`, and `shared/`.

- [ ] **Step 3: Build the web bundle**

Run: `npm run build:web`
Expected: builds cleanly (catches any import/path issue Vitest's module resolution
might not).

- [ ] **Step 4: Manual sanity check (optional but recommended)**

Run: `npm run dev`, sign in, open My Work. Confirm: To-do renders above Previous
activity; a To-do card shows an "updated" time and a wrapped (not truncated) title;
a Previous-activity card with an old (pre-change) summary still renders as plain
prose (no crash); as admin, click "Sync GitHub" and confirm the flash message shows
a "summaries updated" count.
