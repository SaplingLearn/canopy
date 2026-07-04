# Worker Summarizer Prompts (PR + Issue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the PR summarizer prompt to be richer, add a new issue summarizer (full vertical slice: schema, prompt, capture wiring, My Work join), and fix the two things that break as a result — `backfill.ts`'s Sync skip-check/progress metric, and the Sync modal's single progress bar becoming two.

**Architecture:** Two Workers-AI-backed summarizers (`workersAiPrSummarizer` / `workersAiIssueSummarizer`) share one extraction/fallback core in `src/tools/summarize.ts`. PR summaries stay in `pr_summaries` (keyed by `semantic_key`, unchanged); issue summaries land in a new `issue_summaries` table keyed by issue number (an issue's `semantic_key` changes every reassignment, but only the current summary matters). The webhook capture path (`src/webhook.ts`) and the admin backfill/Sync path (`src/tools/backfill.ts`) both gain an issue-summarization seam alongside the existing PR one, sharing one AI-call rate-limit budget. `getMyWork` (`src/tools/mywork.ts`) left-joins the new table into `MyWorkTodo.summary`. The web Sync modal renders two independent progress bars instead of one.

**Tech Stack:** Cloudflare Worker (Hono), D1 (SQLite), Workers AI (`env.AI`), Vitest + Miniflare (`cloudflare:test`), TypeScript, Vite/vanilla-TS web build.

## Global Constraints

- Both summarizer prompts: 2 to 3 sentences of plain prose. No headings, no bullet points, no preamble ("This PR" / "This issue"). Ground everything in the provided title/body — never invent facts, numbers, names, or outcomes not present. Empty/thin body → output the title verbatim, never pad. Output the summary text only, nothing else.
- PR prompt specifically: lead with the concrete change (not a restatement of the title); include meaningful detail the body supports (behavior changed, what it fixes/enables, caveats); the body describes work that already happened, so report what it states, never extrapolate.
- Issue prompt specifically: a plain restatement of what the issue is, plus what needs doing **only** where the issue actually states or clearly implies an action. A vague/aspirational issue gets the plain restatement and nothing more — never invent a next step, plan, or scope the issue never stated.
- Issue summaries are generated **only** for issues that currently have an assignee (mirrors the webhook's `"assigned"` trigger and the fact that unassigned issues never appear in anyone's to-do).
- PR-summary and issue-summary Workers AI calls share **one** `summaryBatchLimit` (default 20) per Sync invocation — do not give issues a separate budget. The PR loop runs first (existing order); a large backlog spends the whole budget on PRs before any issue gets summarized, and that's the accepted, self-correcting behavior.
- `"already summarized"` is `model !== 'excerpt'` on the stored row — never re-derive it from the summary text's shape (the old `parseStructuredSummary` convention is being retired for this purpose; do not reintroduce a text-shape check for the skip logic).
- Workers AI has no test-pool mock (`cloudflare:test` exports no `fetch`/`AI` stub) — every test must inject a stub `Summarizer`, never a real `workersAiPrSummarizer`/`workersAiIssueSummarizer` call. `excerptSummary` is the one path that's real, deterministic, and safe to exercise directly.
- `npm test` runs Vitest against real Miniflare D1; it does **not** run `tsc`. Run `npm run typecheck` separately whenever a task touches types.
- Any new D1 table must be added to `test/apply-migrations.ts`'s per-test truncation list, or state leaks across tests.
- Commit messages: conventional style (`feat(...)`, `test(...)`, `fix(...)`), body optional, trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Out of scope (do not implement): rendering the to-do summary on the actual to-do card (`todoCard` in `web/src/render.ts`) — this plan only makes the data available end-to-end through `MyWorkTodo.summary`; `prActivityCard`'s existing `parseStructuredSummary`-or-plain-prose branch needs no change (a plain-prose PR summary already falls through its "not matched" path); no resumable/bounded backfill cursor beyond the existing shared batch limit; no change to which issue actions get captured as events (`ISSUE_ACTIONS` in `src/webhook.ts` is unchanged).

---

### Task 1: `issue_summaries` migration + row type + test-harness registration

**Files:**
- Create: `migrations/0017_issue_summaries.sql`
- Modify: `shared/rows.ts` (append after `PrSummaryRow`)
- Modify: `test/apply-migrations.ts` (the truncation exec string)
- Test: `test/issue-summary-schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `issue_summaries` table (`issue_number INTEGER PRIMARY KEY`, `summary TEXT NOT NULL`, `model TEXT`, `created_at TEXT NOT NULL`); `IssueSummaryRow` exported from `@shared/rows`. Every later task relies on both.

- [ ] **Step 1: Write the failing test**

Create `test/issue-summary-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import type { IssueSummaryRow } from "@shared/rows";

describe("issue_summaries schema (0017)", () => {
  it("stores a summary keyed by issue_number", async () => {
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`,
      17,
      "What the issue is about.",
      "test-model",
      "2026-07-04T10:00:00Z"
    );
    const row = await first<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 17);
    expect(row).toMatchObject({
      issue_number: 17,
      summary: "What the issue is about.",
      model: "test-model",
      created_at: "2026-07-04T10:00:00Z",
    });
  });

  it("issue_number is the PK: INSERT OR REPLACE overwrites the prior summary for the same issue", async () => {
    await run(env.DB, `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`, 20, "First summary", "m1", "2026-07-04T10:00:00Z");
    await run(env.DB, `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`, 20, "Second summary", "m2", "2026-07-04T11:00:00Z");
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 20);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });

  it("is truncated between tests (test-harness registration)", async () => {
    // If Step 1's row from a prior test file run were still here, this would be 1 not 0.
    expect((await all(env.DB, `SELECT * FROM issue_summaries`)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/issue-summary-schema.test.ts`
Expected: FAIL — `no such table: issue_summaries`.

- [ ] **Step 3: Create the migration**

Create `migrations/0017_issue_summaries.sql`:

```sql
-- Worker-generated summary of ONE assigned issue's own body. A derived
-- projection, regenerable from events.raw; never the source of truth — same
-- posture as pr_summaries (0012). Keyed by issue_number, NOT semantic_key:
-- unlike a PR (merges/closes once), an issue's semantic_key changes on every
-- reassignment/edit, but only the CURRENT summary matters for the to-do list.
-- No FK to events — there is no stable 1:1 semantic_key to reference.
CREATE TABLE issue_summaries (
  issue_number INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT,                          -- generator id, or 'excerpt' for the deterministic fallback
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Add `IssueSummaryRow` to `shared/rows.ts`**

Append directly after the `PrSummaryRow` interface:

```ts
// Worker-generated summary of ONE assigned issue's own body (0017). Derived,
// regenerable, never truth — keyed by issue number (not semantic_key), since
// only the current summary matters across reassignments/edits.
export interface IssueSummaryRow {
  issue_number: number;
  summary: string;
  model: string | null;    // 'excerpt' = deterministic fallback
  created_at: string;
}
```

- [ ] **Step 5: Register the table in `test/apply-migrations.ts`**

Find the single exec string (it truncates `pr_summaries` among others) and add `DELETE FROM issue_summaries;` right after `DELETE FROM pr_summaries;`:

```ts
"DELETE FROM processed_items; DELETE FROM pr_summaries; DELETE FROM issue_summaries; DELETE FROM events; DELETE FROM milestone_progress; ..."
```

(Keep everything else in that string exactly as-is — only insert the one new `DELETE FROM issue_summaries;` clause.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/issue-summary-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green, no type errors.

- [ ] **Step 8: Commit**

```bash
git add migrations/0017_issue_summaries.sql shared/rows.ts test/apply-migrations.ts test/issue-summary-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): issue_summaries table for assigned-issue summaries (0017)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Capture issue `body` (webhook + backfill + fixtures)

Neither `eventsFromDelivery`'s issue branch (`src/webhook.ts`) nor `backfill.ts`'s `issueDelivery` capture `issue.body` today — nothing needed it before this feature. Both GitHub's webhook payload and the REST issues-list response already include it, so this is purely widening the existing capture, not a new GitHub call.

**Files:**
- Modify: `src/webhook.ts` (the `GhIssue` interface; `eventsFromDelivery`'s issue-branch `raw` object)
- Modify: `src/tools/backfill.ts` (the `GhIssueListItem` interface; `issueDelivery`'s raw issue object; the `openIssue` test fixture lives in `test/backfill.test.ts`, touched in the test step below)
- Modify: `test/fixtures/gh-issue-assigned.json`, `test/fixtures/gh-issue-closed.json`
- Modify: `test/webhook.test.ts` (one assertion added to the existing `eventsFromDelivery` issue test)
- Modify: `test/backfill.test.ts` (`openIssue` fixture gains `body`)

**Interfaces:**
- Consumes: nothing new.
- Produces: every captured issue event's `raw` JSON now includes `issue.body: string | null`; `GhIssueListItem.body` (backfill) is available to `runBackfill`. Tasks 4 and 7 (the issue-summary wiring) rely on this.

- [ ] **Step 1: Write the failing test**

In `test/webhook.test.ts`, in the `describe("eventsFromDelivery — pure derivation", ...)` block, extend the existing `"issues/assigned → subject is the assignee..."` test by adding one assertion at the end (after the `milestone` assertion):

```ts
    expect(raw.issue.body).toBe("Full description of what needs wiring."); // NEW: needed by the issue summarizer
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/webhook.test.ts`
Expected: FAIL — `raw.issue.body` is `undefined`, not the expected string.

- [ ] **Step 3: Add `body` to the test fixtures**

In `test/fixtures/gh-issue-assigned.json`, add a `"body"` key inside `"issue"` (after `"title"`):

```json
{
  "action": "assigned",
  "assignee": { "login": "Jose-Gael-Cruz-Lopez" },
  "issue": {
    "number": 17,
    "title": "[P1] Wire the milestone progress cache",
    "body": "Full description of what needs wiring.",
    "html_url": "https://github.com/SaplingLearn/canopy/issues/17",
    "state": "open",
    "updated_at": "2026-07-01T17:05:00Z",
    "user": { "login": "AndresL230" },
    "assignees": [{ "login": "Jose-Gael-Cruz-Lopez" }],
    "labels": [{ "name": "P1" }, { "name": "backend" }],
    "milestone": { "number": 3, "open_issues": 2, "closed_issues": 4 }
  }
}
```

In `test/fixtures/gh-issue-closed.json`, add the same key:

```json
{
  "action": "closed",
  "issue": {
    "number": 17,
    "title": "[P1] Wire the milestone progress cache",
    "body": "Full description of what needs wiring.",
    "html_url": "https://github.com/SaplingLearn/canopy/issues/17",
    "state": "closed",
    "updated_at": "2026-07-01T19:40:00Z",
    "user": { "login": "AndresL230" },
    "assignees": [{ "login": "Jose-Gael-Cruz-Lopez" }],
    "labels": [{ "name": "P1" }, { "name": "backend" }],
    "milestone": { "number": 3, "open_issues": 1, "closed_issues": 5 }
  }
}
```

- [ ] **Step 4: Widen capture in `src/webhook.ts`**

In the `GhIssue` interface, add a `body` field (after `title`):

```ts
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  user: GhUser;
  assignees?: GhUser[];
  labels?: (string | GhLabel)[];
  milestone?: GhMilestone | null;
  pull_request?: unknown; // present only when the "issue" is really a PR
}
```

In `eventsFromDelivery`'s `"issues"` branch, the `raw` JSON's `issue` object currently starts:

```ts
    const raw = JSON.stringify({
      action,
      issue: {
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
```

Add a `body` line right after `title`:

```ts
    const raw = JSON.stringify({
      action,
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.html_url,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/webhook.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Widen capture in `src/tools/backfill.ts`, and add `body` to the `openIssue` test fixture**

In the `GhIssueListItem` interface, add a `body` field (after `title`):

```ts
interface GhIssueListItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  user: GhUserLite;
  assignees?: GhUserLite[];
  assignee?: GhUserLite | null;
  labels?: (string | { name: string })[];
  milestone?: GhMilestoneLite | null;
  pull_request?: unknown; // present only when the "issue" is really a PR
}
```

In `issueDelivery()`, the returned `issue` object currently starts:

```ts
    issue: {
      number: issue.number,
      title: issue.title,
      html_url: issue.html_url,
```

Add `body` right after `title`:

```ts
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.html_url,
```

In `test/backfill.test.ts`, add a `body` field to the existing `openIssue` fixture object (it currently has no `body` key):

```ts
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
  body: "Full description of the bug.",
};
```

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green (the `GhIssueListItem`/`GhIssue` field addition is additive — nothing reads `body` yet, so no other test's behavior changes).

- [ ] **Step 8: Commit**

```bash
git add src/webhook.ts src/tools/backfill.ts test/fixtures/gh-issue-assigned.json test/fixtures/gh-issue-closed.json test/webhook.test.ts test/backfill.test.ts
git commit -m "$(cat <<'EOF'
feat(webhook): capture issue body in webhook and backfill events

Neither path captured it before — nothing needed it. Both GitHub's
webhook payload and the REST issues-list response already include it,
so this widens existing capture rather than adding a new GitHub call.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite the PR prompt, add the issue prompt, refactor the summarizer factory, add `storeIssueSummary`

**Files:**
- Modify: `src/tools/summarize.ts`
- Modify: `src/webhook.ts` (rename `workersAiSummarizer` → `workersAiPrSummarizer` at the one call site — mechanical, no behavior change)
- Modify: `src/tools/backfill.ts` (same rename at its one call site)
- Modify: `test/summarize.test.ts`

**Interfaces:**
- Consumes: `IssueSummaryRow` (Task 1).
- Produces: `SUMMARIZER_SYSTEM_PROMPT` (rewritten), `ISSUE_SUMMARIZER_SYSTEM_PROMPT` (new), `workersAiPrSummarizer(ai: Ai): Summarizer`, `workersAiIssueSummarizer(ai: Ai): Summarizer` (replacing the old single `workersAiSummarizer` export), `storeIssueSummary(db: DB, summarizer: Summarizer | null, issue: { issue_number: number; title: string; body: string }): Promise<IssueSummaryRow>`. Tasks 4 and 7 call `workersAiIssueSummarizer` and `storeIssueSummary`; Tasks 4, 5, 7 call `workersAiPrSummarizer` (renamed from `workersAiSummarizer`).

- [ ] **Step 1: Write the failing tests**

In `test/summarize.test.ts`, change the import block (currently):

```ts
import { storePrSummary, excerptSummary, SUMMARIZER_SYSTEM_PROMPT, workersAiSummarizer } from "../src/tools/summarize";
```

to:

```ts
import {
  storePrSummary,
  storeIssueSummary,
  excerptSummary,
  SUMMARIZER_SYSTEM_PROMPT,
  ISSUE_SUMMARIZER_SYSTEM_PROMPT,
  workersAiPrSummarizer,
  workersAiIssueSummarizer,
} from "../src/tools/summarize";
```

and add `IssueSummaryRow` to the existing `@shared/rows` type import (currently `import type { PrSummaryRow } from "@shared/rows";`):

```ts
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
```

Replace the `describe("SUMMARIZER_SYSTEM_PROMPT", ...)` block (the old structured-format assertion) with:

```ts
describe("SUMMARIZER_SYSTEM_PROMPT", () => {
  it("asks for 2-3 sentences of plain prose, not the old structured What changed/Why convention", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).not.toContain("**What changed:**");
    expect(SUMMARIZER_SYSTEM_PROMPT).not.toContain("**Why:**");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("2 to 3 sentences");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("no headings");
  });
});

describe("ISSUE_SUMMARIZER_SYSTEM_PROMPT", () => {
  it("asks for a plain restatement plus what needs doing only when the issue supports it", () => {
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain("2 to 3 sentences");
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain("never invent a next step");
  });
});
```

Rename the block's own title and every `workersAiSummarizer(` call inside it to `workersAiPrSummarizer` — i.e. change `describe("workersAiSummarizer — response shape handling", ...)` to `describe("workersAiPrSummarizer — response shape handling", ...)`, and each of the 4 `workersAiSummarizer(fakeAi)` call sites inside it to `workersAiPrSummarizer(fakeAi)` (the response-shape extraction logic is shared; this block just exercises it through the PR factory).

Append a new `describe` block at the end of the file for `storeIssueSummary`:

```ts
describe("storeIssueSummary", () => {
  it("stores the stub summarizer's summary under its own model id", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "What it is and what to do." };
    const row = await storeIssueSummary(env.DB, stub, { issue_number: 1, title: "Some issue", body: "Some body" });
    expect(row.summary).toBe("What it is and what to do.");
    expect(row.model).toBe("stub");
    expect(row.issue_number).toBe(1);

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 1);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("What it is and what to do.");
  });

  it("falls back to excerptSummary (model:'excerpt') when the summarizer returns null, and never throws", async () => {
    const nullStub: Summarizer = { model: "stub", summarize: async () => null };
    const row = await storeIssueSummary(env.DB, nullStub, { issue_number: 2, title: "Another issue", body: "Body text here" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("Another issue", "Body text here"));
  });

  it("falls back to excerptSummary when the summarizer throws, and never throws", async () => {
    const throwingStub: Summarizer = {
      model: "stub",
      summarize: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      storeIssueSummary(env.DB, throwingStub, { issue_number: 3, title: "Third issue", body: "" })
    ).resolves.not.toThrow();
    const row = await storeIssueSummary(env.DB, throwingStub, { issue_number: 3, title: "Third issue", body: "" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Third issue"); // empty body → title
  });

  it("falls back to excerptSummary when no summarizer is provided (null)", async () => {
    const row = await storeIssueSummary(env.DB, null, { issue_number: 4, title: "Fourth issue", body: "   " });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Fourth issue"); // whitespace-only body collapses to empty → title
  });

  it("INSERT OR REPLACE overwrites the prior summary for the same issue_number", async () => {
    const s1: Summarizer = { model: "m1", summarize: async () => "First summary" };
    await storeIssueSummary(env.DB, s1, { issue_number: 5, title: "Issue", body: "body" });
    const s2: Summarizer = { model: "m2", summarize: async () => "Second summary" };
    await storeIssueSummary(env.DB, s2, { issue_number: 5, title: "Issue", body: "body" });
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 5);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/summarize.test.ts`
Expected: FAIL — `storeIssueSummary`, `ISSUE_SUMMARIZER_SYSTEM_PROMPT`, `workersAiIssueSummarizer`, `workersAiPrSummarizer` are not exported yet; the old `SUMMARIZER_SYSTEM_PROMPT` still contains `**What changed:**`.

- [ ] **Step 3: Rewrite `src/tools/summarize.ts`**

This file has, in order: the `WORKERS_AI_MODEL` const, a stale comment + `SUMMARIZER_SYSTEM_PROMPT`, `extractResponseText`, and a docstring + `workersAiSummarizer`. Only the SECOND and FOURTH of those change — `WORKERS_AI_MODEL` and `extractResponseText` (and its own comment) stay exactly as they are, untouched, in between. Do NOT do one contiguous replacement spanning the whole region, or `extractResponseText` gets deleted along with it.

**3a.** Replace the stale comment + `SUMMARIZER_SYSTEM_PROMPT` block — currently:

```ts
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
```

with:

```ts
// Both prompts: 2-3 sentences of plain prose, no headings/bullets/preamble,
// grounded only in the provided title+body, output the summary text only.
// Kept in sync by hand — there's no shared style-rule constant, just the two
// prompts below and this comment as the source of truth for both.

export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this pull request for a team activity feed — what shipped. " +
  "Lead with the concrete change the PR made; do not just restate the title. " +
  "Where the description supports it, add the meaningful detail: what behavior changed, " +
  "what it fixes or enables, and any caveat a teammate would want to know. " +
  "The description is a record of work that already happened — report what it states, never extrapolate beyond it. " +
  "Write 2 to 3 sentences of plain prose: no headings, no bullet points, no preamble like \"This PR\". " +
  "If the description is empty or too thin to add anything beyond the title, output the title verbatim — do not pad. " +
  "Output the summary text only, nothing else.";

export const ISSUE_SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this GitHub issue for a personal to-do list: what it is, and — only where the issue " +
  "actually states or clearly implies one — what needs doing about it. " +
  "Start with a plain restatement of what the issue is about, grounded only in its title and description. " +
  "If the description states or clearly implies an action, add what needs doing. " +
  "If the description is vague, aspirational, or states no clear action, stop at the plain restatement — " +
  "never invent a next step, a plan, or a scope the issue itself never stated. " +
  "Write 2 to 3 sentences of plain prose: no headings, no bullet points, no preamble like \"This issue\". " +
  "If the description is empty or too thin to add anything beyond the title, output the title verbatim — do not pad. " +
  "Output the summary text only, nothing else.";
```

(`extractResponseText` immediately follows this in the file — leave it exactly as-is.)

**3b.** Replace the docstring + `workersAiSummarizer` function — currently:

```ts
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
        const response = extractResponseText(result);
        if (response === null) return null;
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch (err) {
        // TEMPORARY diagnostic logging — remove once the production failure
        // mode under sustained backfill load is identified (see tail output).
        console.error("workersAiSummarizer failed:", err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}
```

with:

```ts
/** Shared Workers AI call machinery for both summarizers — only the system
 *  prompt differs. Never throws: any failure (network, empty output,
 *  malformed response) resolves to null so the caller falls back to
 *  excerptSummary. */
function makeWorkersAiSummarizer(ai: Ai, systemPrompt: string): Summarizer {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      try {
        const result = await ai.run(WORKERS_AI_MODEL, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
          ],
        });
        const response = extractResponseText(result);
        if (response === null) return null;
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch (err) {
        // TEMPORARY diagnostic logging — remove once the production failure
        // mode under sustained backfill load is identified (see tail output).
        console.error("workersAiSummarizer failed:", err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent. */
export function workersAiPrSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, SUMMARIZER_SYSTEM_PROMPT);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent. */
export function workersAiIssueSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, ISSUE_SUMMARIZER_SYSTEM_PROMPT);
}
```

Add `IssueSummaryRow` to the existing `@shared/rows` type import at the top of the file (currently `import type { PrSummaryRow } from "@shared/rows";`):

```ts
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
```

Then append `storeIssueSummary` at the end of the file, right after `storePrSummary`:

```ts
/**
 * Try the summarizer, fall back to excerptSummary (model:'excerpt') on any
 * null/throw. INSERT OR REPLACE so a re-summarize overwrites the one row per
 * issue_number (an issue can be reassigned/edited many times; only the
 * current summary matters). NEVER throws.
 */
export async function storeIssueSummary(
  db: DB,
  summarizer: Summarizer | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow> {
  let summary: string | null = null;
  let model = "excerpt";

  if (summarizer) {
    try {
      summary = await summarizer.summarize({ title: issue.title, body: issue.body });
      if (summary) model = summarizer.model;
    } catch {
      summary = null;
    }
  }

  if (!summary) {
    summary = excerptSummary(issue.title, issue.body);
    model = "excerpt";
  }

  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`,
    issue.issue_number,
    summary,
    model,
    created_at
  );

  return { issue_number: issue.issue_number, summary, model, created_at };
}
```

- [ ] **Step 4: Rename the one call site in `src/webhook.ts`**

Change the import line:

```ts
import { type Summarizer, workersAiSummarizer, storePrSummary } from "./tools/summarize";
```

to:

```ts
import { type Summarizer, workersAiPrSummarizer, storePrSummary } from "./tools/summarize";
```

And inside `handleGithubWebhook`, change:

```ts
        const summarizer = opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null);
```

to:

```ts
        const summarizer = opts?.summarizer ?? (env.AI ? workersAiPrSummarizer(env.AI) : null);
```

- [ ] **Step 5: Rename the one call site in `src/tools/backfill.ts`**

Change the import line:

```ts
import { type Summarizer, workersAiSummarizer, storePrSummary } from "./summarize";
```

to:

```ts
import { type Summarizer, workersAiPrSummarizer, storePrSummary } from "./summarize";
```

And change:

```ts
  const summarizer = opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null);
```

to:

```ts
  const summarizer = opts?.summarizer ?? (env.AI ? workersAiPrSummarizer(env.AI) : null);
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green. `test/webhook.test.ts` and `test/backfill.test.ts` are unaffected in behavior (they inject stub summarizers via `opts.summarizer`, never call `workersAiSummarizer`/`workersAiPrSummarizer` by name).

- [ ] **Step 7: Commit**

```bash
git add src/tools/summarize.ts src/webhook.ts src/tools/backfill.ts test/summarize.test.ts
git commit -m "$(cat <<'EOF'
feat(summarize): richer PR prompt, new issue prompt, shared factory

SUMMARIZER_SYSTEM_PROMPT drops the terse structured What changed/Why
convention for 2-3 sentences of plain prose that leads with the
concrete change and includes detail the PR body supports.
ISSUE_SUMMARIZER_SYSTEM_PROMPT is new: a plain restatement plus what
needs doing, only when the issue actually supports it. Both share one
Workers AI call core (makeWorkersAiSummarizer); workersAiSummarizer is
renamed workersAiPrSummarizer to sit alongside the new
workersAiIssueSummarizer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Webhook wiring — `summarizeIssueSeam` on assigned-issue capture

**Files:**
- Modify: `src/webhook.ts`
- Modify: `test/webhook.test.ts`

**Interfaces:**
- Consumes: `workersAiIssueSummarizer`, `storeIssueSummary` (Task 3); issue `raw.issue.body` (Task 2).
- Produces: every newly-captured `"assigned"` issue event gets an `issue_summaries` row. `handleGithubWebhook`'s `opts` gains `issueSummarizer?: Summarizer | null` (mirrors `summarizer`) so tests can inject a stub.

- [ ] **Step 1: Write the failing tests**

In `test/webhook.test.ts`, add to the existing type imports:

```ts
import type { Summarizer } from "../src/tools/summarize";
import type { IssueSummaryRow } from "@shared/rows";
```

Change the `postWebhook` helper to accept optional `opts` (currently it only takes `eventName, payload, e`):

```ts
async function postWebhook(
  eventName: string,
  payload: unknown,
  e: Env = env,
  opts?: { summarizer?: Summarizer | null; issueSummarizer?: Summarizer | null }
): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = await sign(SECRET, body);
  return handleGithubWebhook(
    req(body, { "x-github-event": eventName, "x-hub-signature-256": sig, "content-type": "application/json" }),
    e,
    opts
  );
}
```

Append a new `describe` block after `describe("progressFromIssueEvent — pure derivation", ...)`:

```ts
describe("webhook → issue summarize wiring", () => {
  it("an assigned issue event → one issue_summaries row keyed by issue number", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "What it is and what to do." };
    const res = await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 17);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("What it is and what to do.");
  });

  it("a non-assigned issue action (closed) never reaches storeIssueSummary — zero issue_summaries rows", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "should never be called" };
    const res = await postWebhook("issues", issueClosed, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all(env.DB, `SELECT * FROM issue_summaries`);
    expect(rows.length).toBe(0);
  });

  it("still runs progressSeam for an assigned issue event (both seams fire, not either/or)", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "summary" };
    await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    const progress = await all(env.DB, `SELECT * FROM milestone_progress`);
    expect(progress.length).toBe(1); // issueAssigned carries a milestone — progressSeam still wrote it
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/webhook.test.ts`
Expected: FAIL — `issue_summaries` stays empty for the assigned event (no seam exists yet); TypeScript also complains that `opts.issueSummarizer` doesn't exist on `handleGithubWebhook`'s signature.

- [ ] **Step 3: Implement the seam in `src/webhook.ts`**

Change the import line (from Task 3's rename) to add the issue summarizer pieces:

```ts
import { type Summarizer, workersAiPrSummarizer, workersAiIssueSummarizer, storePrSummary, storeIssueSummary } from "./tools/summarize";
```

Add `summarizeIssueSeam` right after the existing `summarizePrSeam` function:

```ts
// Task: mirror summarizePrSeam for issues, but ONLY on the "assigned" action —
// unassigned/opened/closed issue events never need a summary (they never
// appear in anyone's to-do). Action isn't distinguishable from event_type
// alone (every issue action is captured as event_type:"issue"), so it's read
// back off the event's own raw JSON.
async function summarizeIssueSeam(db: DB, summarizer: Summarizer | null, event: CapturedEvent): Promise<void> {
  const parsed = JSON.parse(event.raw) as { action: string; issue: { number: number; title: string; body: string | null } };
  if (parsed.action !== "assigned") return;
  await storeIssueSummary(db, summarizer, {
    issue_number: parsed.issue.number,
    title: parsed.issue.title,
    body: parsed.issue.body ?? "",
  });
}
```

Change `handleGithubWebhook`'s signature:

```ts
export async function handleGithubWebhook(
  request: Request,
  env: Env,
  opts?: { summarizer?: Summarizer | null; issueSummarizer?: Summarizer | null }
): Promise<Response> {
```

And its per-event branch — currently:

```ts
      if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
        const summarizer = opts?.summarizer ?? (env.AI ? workersAiPrSummarizer(env.AI) : null);
        await summarizePrSeam(env.DB, summarizer, ev);
      } else {
        await progressSeam(env.DB, payload);
      }
```

becomes:

```ts
      if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
        const summarizer = opts?.summarizer ?? (env.AI ? workersAiPrSummarizer(env.AI) : null);
        await summarizePrSeam(env.DB, summarizer, ev);
      } else {
        await progressSeam(env.DB, payload);
        const issueSummarizer = opts?.issueSummarizer ?? (env.AI ? workersAiIssueSummarizer(env.AI) : null);
        await summarizeIssueSeam(env.DB, issueSummarizer, ev);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/webhook.test.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/webhook.ts test/webhook.test.ts
git commit -m "$(cat <<'EOF'
feat(webhook): summarize an issue at capture time when it's assigned

Mirrors summarizePrSeam for issues, gated on action:"assigned" only —
unassigned/opened/closed issue events never need a summary since they
never surface in anyone's to-do. Runs alongside progressSeam, not
instead of it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Backfill — fix the PR skip-check (`structuredCount` → `prSummarizedCount`)

The prompt rewrite in Task 3 means every future PR summary is plain prose with no `**What changed:**` marker, so `parseStructuredSummary(existing.summary) !== null` (the current skip-check) would permanently fail for every future summary — Sync would re-summarize every closed PR on every run, forever, and the `structuredCount`-driven progress bar would never advance. This task redefines "already summarized" as `model !== 'excerpt'`, independent of the summary text's shape.

**Files:**
- Modify: `src/tools/backfill.ts`
- Modify: `test/backfill.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BackfillResult.prSummarizedCount` (replaces `structuredCount`). Task 7 extends `BackfillResult` further (adds the issue-side fields) and Task 8 (web) consumes the renamed field.

- [ ] **Step 1: Update the failing/changed tests**

In `test/backfill.test.ts`, in the first test (`"captures ALL closed PRs..."`), change:

```ts
    expect(res.structuredCount).toBe(0); // "AI summary" isn't structured — neither counts toward "done"
```

to:

```ts
    expect(res.prSummarizedCount).toBe(2); // both newly-summarized PRs count toward "done" (model !== 'excerpt')
```

Replace the entire `"retroactively re-summarizes a PR whose existing summary is NOT structured"` test with:

```ts
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
```

Replace the entire `"skips re-summarizing a PR whose existing summary is already structured"` test with:

```ts
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
```

In the `"returns {ok:false}..."` test, change:

```ts
    expect(res).toMatchObject({ captured: 0, unchanged: 0, summarized: 0, summaryBudgetExhausted: false, structuredCount: 0, prs: 0, issues: 0 });
```

to:

```ts
    expect(res).toMatchObject({ captured: 0, unchanged: 0, summarized: 0, summaryBudgetExhausted: false, prSummarizedCount: 0, prs: 0, issues: 0 });
```

In the `"caps AI summarization at summaryBatchLimit..."` test, rename both `res.structuredCount` references (values are unchanged — 2, then 3):

```ts
    expect(firstRun.prSummarizedCount).toBe(2); // 2 of 3 done so far — the "X of Y" progress bar's numerator
```

```ts
    expect(secondRun.prSummarizedCount).toBe(3); // all 3 now done
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/backfill.test.ts`
Expected: FAIL — `res.prSummarizedCount` is `undefined` (the field is still named `structuredCount` in `BackfillResult`); the rewritten tests fail against the old `parseStructuredSummary`-based skip logic.

- [ ] **Step 3: Implement in `src/tools/backfill.ts`**

Remove the now-unused import:

```ts
import { parseStructuredSummary } from "@shared/prSummary";
```

Rename the field in `BackfillResult`:

```ts
  /** How many of `prs` already have a real (non-excerpt) summary — the "X of Y" the frontend shows. */
  prSummarizedCount: number;
```

(replacing the old `structuredCount` field + its old comment).

In the early-return object (missing service token/repo), rename:

```ts
      prSummarizedCount: 0,
```

Rename the running counter declaration:

```ts
  // Running count of PRs that end this call with a real (non-excerpt) summary —
  // either already had one, or got one just now. Paired with prList.length, this
  // is the "X of Y" progress the frontend shows across a multi-batch sync.
  let prSummarizedCount = 0;
```

Replace the skip-check block:

```ts
      const existing = await first<PrSummaryRow>(
        env.DB,
        `SELECT summary FROM pr_summaries WHERE semantic_key = ?`,
        ev.semantic_key
      );
      const alreadyStructured = existing !== null && parseStructuredSummary(existing.summary) !== null;
      if (alreadyStructured) {
        structuredCount++;
        continue;
      }
```

with:

```ts
      const existing = await first<PrSummaryRow>(
        env.DB,
        `SELECT model FROM pr_summaries WHERE semantic_key = ?`,
        ev.semantic_key
      );
      const alreadySummarized = existing !== null && existing.model !== "excerpt";
      if (alreadySummarized) {
        prSummarizedCount++;
        continue;
      }
```

Replace the post-summarize count:

```ts
      summarized++;
      // storePrSummary can still fall back to excerpt if the AI call failed —
      // only count it toward "done" if it actually landed in structured form.
      if (parseStructuredSummary(stored.summary) !== null) structuredCount++;
```

with:

```ts
      summarized++;
      // storePrSummary can still fall back to excerpt if the AI call failed —
      // only count it toward "done" if it actually got a real summary.
      if (stored.model !== "excerpt") prSummarizedCount++;
```

And rename the field in the final return object:

```ts
    prSummarizedCount,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/backfill.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green. (`shared/prSummary.ts` and its own test file, and `web/src/render.ts`'s `prActivityCard`, still import `parseStructuredSummary` for rendering — untouched, only `backfill.ts`'s import is removed.)

- [ ] **Step 6: Commit**

```bash
git add src/tools/backfill.ts test/backfill.test.ts
git commit -m "$(cat <<'EOF'
fix(backfill): redefine "already summarized" as model !== 'excerpt'

The old parseStructuredSummary-based skip check would permanently fail
for every future PR summary once the prompt moves to plain prose (no
**What changed:** marker) — Sync would re-summarize every closed PR on
every run forever. structuredCount is renamed prSummarizedCount to
match the new, text-shape-independent semantics.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: My Work — `MyWorkTodo.summary` + `getMyWork` join

**Files:**
- Modify: `shared/dashboard.ts`
- Modify: `src/tools/mywork.ts`
- Modify: `test/mywork.test.ts`
- Modify: `test/render.mywork.test.ts` (compile fix only — `makeTodo()`'s base object must satisfy the widened `MyWorkTodo` type; `todoCard` rendering itself is unchanged/out of scope)

**Interfaces:**
- Consumes: `issue_summaries` table (Task 1), `storeIssueSummary` (Task 3).
- Produces: `MyWorkTodo.summary: string | null`; `getMyWork`'s `todo` list carries the joined summary.

- [ ] **Step 1: Write the failing test**

In `test/mywork.test.ts`, add `storeIssueSummary` to the existing import:

```ts
import { storePrSummary, storeIssueSummary } from "../src/tools/summarize";
```

Append a new `describe` block at the end of the file:

```ts
describe("getMyWork — todo carries the issue summary", () => {
  it("joins issue_summaries by issue number; null until a summary exists", async () => {
    const assigned = issueEvent({
      number: 8,
      login: "AndresL230",
      action: "assigned",
      state: "open",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    await ingestEvent(env.DB, assigned, "github-webhook");

    let work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBeNull();

    await storeIssueSummary(env.DB, null, { issue_number: 8, title: "Issue 8", body: "some body" });
    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBe("some body"); // excerpt fallback (no summarizer)
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/mywork.test.ts`
Expected: FAIL — `work.todo[...].summary` is `undefined` (the field doesn't exist on `MyWorkTodo` yet, and TypeScript will also flag the missing property).

- [ ] **Step 3: Widen `MyWorkTodo` in `shared/dashboard.ts`**

```ts
export interface MyWorkTodo {
  number: number;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
  summary: string | null;
}
```

- [ ] **Step 4: Join in `src/tools/mywork.ts`**

Add a `summary` field to the `IssueSnapshotRow` interface:

```ts
interface IssueSnapshotRow {
  ref_number: number;
  raw: string;
  summary: string | null;
}
```

Replace the issue query — currently:

```ts
    const issueRows = await all<IssueSnapshotRow>(
      db,
      `SELECT ref_number, raw FROM (
         SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
         FROM events WHERE event_type = 'issue'
       ) WHERE rn = 1
       ORDER BY ref_number ASC`
    );
```

with:

```ts
    const issueRows = await all<IssueSnapshotRow>(
      db,
      `SELECT e.ref_number, e.raw, s.summary AS summary
       FROM (
         SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
         FROM events WHERE event_type = 'issue'
       ) e
       LEFT JOIN issue_summaries s ON s.issue_number = e.ref_number
       WHERE e.rn = 1
       ORDER BY e.ref_number ASC`
    );
```

And add `summary: row.summary` to the `todo.push(...)` call:

```ts
      todo.push({
        number: issue.number,
        title: stripPriority(issue.title),
        priority: priorityOf(issue.title),
        labels: issue.labels,
        url: issue.html_url,
        updatedAt: issue.updated_at,
        summary: row.summary,
      });
```

- [ ] **Step 5: Fix the compile break in `test/render.mywork.test.ts`**

`makeTodo()`'s base object literal must satisfy the widened `MyWorkTodo` type. Add `summary: null` to it:

```ts
function makeTodo(overrides: Partial<MyWorkTodo> = {}): MyWorkTodo {
  return {
    number: 7,
    title: "Investigate flaky test",
    priority: "P1",
    labels: ["bug", "flaky", "ci", "extra"],
    url: "https://github.com/SaplingLearn/sapling/issues/7",
    updatedAt: new Date().toISOString(),
    summary: null,
    ...overrides,
  };
}
```

(`todoCard` itself is unchanged — this is a type-compile fix only, not a rendering change.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mywork.test.ts test/render.mywork.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add shared/dashboard.ts src/tools/mywork.ts test/mywork.test.ts test/render.mywork.test.ts
git commit -m "$(cat <<'EOF'
feat(mywork): join issue_summaries into MyWorkTodo.summary

Mirrors the existing pr_summaries join used for previousActivity.
todoCard rendering is unchanged/out of scope for this change — this
makes the summary available on the DTO end-to-end.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Backfill — issue summarization loop + shared AI-call budget

**Files:**
- Modify: `src/tools/backfill.ts`
- Modify: `test/backfill.test.ts`

**Interfaces:**
- Consumes: `workersAiIssueSummarizer`, `storeIssueSummary` (Task 3); `issue.body` (Task 2); `prSummarizedCount` semantics (Task 5).
- Produces: `BackfillResult.issueSummarizedCount`, `BackfillResult.issuesToSummarize`; `runBackfill`'s `opts` gains `issueSummarizer?: Summarizer | null`. Task 8 (web) consumes both new fields.

- [ ] **Step 1: Write the failing tests**

In `test/backfill.test.ts`, add a new fixture after `prAsIssue`:

```ts
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
```

Add `IssueSummaryRow` to the existing `@shared/rows` type import:

```ts
import type { EventRow, PrSummaryRow, IssueSummaryRow } from "@shared/rows";
```

Append a new `describe` block at the end of the file:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/backfill.test.ts`
Expected: FAIL — `issueSummarizedCount`/`issuesToSummarize` are `undefined`; `opts.issueSummarizer` doesn't type-check yet.

- [ ] **Step 3: Implement in `src/tools/backfill.ts`**

Add to the existing `./summarize` import:

```ts
import { type Summarizer, workersAiPrSummarizer, workersAiIssueSummarizer, storePrSummary, storeIssueSummary } from "./summarize";
```

Add `IssueSummaryRow` to the existing `@shared/rows` type import:

```ts
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
```

Extend `BackfillResult` (already has `prSummarizedCount` from Task 5):

```ts
export interface BackfillResult {
  ok: boolean;
  error?: string;
  captured: number;
  unchanged: number;
  summarized: number;
  summaryBudgetExhausted: boolean;
  prSummarizedCount: number;
  issueSummarizedCount: number;
  prs: number;
  issues: number;
  issuesToSummarize: number;
}
```

Add the two new fields to the early-return (missing service token/repo) object:

```ts
      prSummarizedCount: 0,
      issueSummarizedCount: 0,
      issuesToSummarize: 0,
```

Add `opts.issueSummarizer` to `runBackfill`'s signature:

```ts
export async function runBackfill(
  env: Env,
  principalLogin: string,
  opts?: {
    fetchImpl?: typeof fetch;
    summarizer?: Summarizer | null;
    issueSummarizer?: Summarizer | null;
    summaryBatchLimit?: number;
    summaryCallDelayMs?: number;
  }
): Promise<BackfillResult> {
```

Resolve it alongside the existing `summarizer` line:

```ts
  const summarizer = opts?.summarizer ?? (env.AI ? workersAiPrSummarizer(env.AI) : null);
  const issueSummarizer = opts?.issueSummarizer ?? (env.AI ? workersAiIssueSummarizer(env.AI) : null);
```

Replace the issue loop — currently:

```ts
  for (const issue of issueList) {
    const payload = issueDelivery(issue);
    for (const base of eventsFromDelivery("issues", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(env.DB, ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        // Mirror handleGithubWebhook's progress seam for newly-written issues.
        await applyEventProgress(env.DB, payload);
      } else {
        unchanged++;
      }
    }
  }

  return {
    ok: true,
    captured,
    unchanged,
    summarized,
    summaryBudgetExhausted,
    prSummarizedCount,
    prs: prList.length,
    issues: issueList.length,
  };
}
```

with:

```ts
  let issueSummarizedCount = 0;
  let issuesToSummarize = 0; // denominator: assigned issues found this run

  for (const issue of issueList) {
    const payload = issueDelivery(issue);
    const isAssigned = payload.action === "assigned";
    if (isAssigned) issuesToSummarize++;

    for (const base of eventsFromDelivery("issues", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(env.DB, ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        // Mirror handleGithubWebhook's progress seam for newly-written issues.
        await applyEventProgress(env.DB, payload);
      } else {
        unchanged++;
      }

      if (!isAssigned) continue; // unassigned issues never appear in anyone's to-do

      const existing = await first<IssueSummaryRow>(
        env.DB,
        `SELECT model FROM issue_summaries WHERE issue_number = ?`,
        issue.number
      );
      const alreadySummarized = existing !== null && existing.model !== "excerpt";
      if (alreadySummarized) {
        issueSummarizedCount++;
        continue;
      }

      // Shares the SAME summarized/summaryBatchLimit budget as the PR loop
      // above — not a separate allowance. See Global Constraints.
      if (summarized >= summaryBatchLimit) {
        summaryBudgetExhausted = true;
        continue;
      }

      await storeIssueSummary(env.DB, issueSummarizer, {
        issue_number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
      });
      summarized++;
      issueSummarizedCount++;

      if (summarized < summaryBatchLimit && summaryCallDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, summaryCallDelayMs));
      }
    }
  }

  return {
    ok: true,
    captured,
    unchanged,
    summarized,
    summaryBudgetExhausted,
    prSummarizedCount,
    issueSummarizedCount,
    prs: prList.length,
    issues: issueList.length,
    issuesToSummarize,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/backfill.test.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/backfill.ts test/backfill.test.ts
git commit -m "$(cat <<'EOF'
feat(backfill): summarize assigned issues during Sync

Mirrors the PR loop's resummarize-unless-done / budget-check / call /
pace pattern, limited to issues that currently have an assignee.
Shares ONE AI-call budget with the PR loop rather than a separate
allowance — PRs are processed first, so a large backlog spends the
whole budget on PRs before any issue gets summarized; that's expected
and self-corrects across Sync clicks.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Web — `BackfillResult` type + two-bar Sync UI

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/main.ts`
- Modify: `web/src/render.ts`
- Modify: `test/render.mywork.test.ts`

**Interfaces:**
- Consumes: the renamed/extended `BackfillResult` fields from Tasks 5 and 7 (`prSummarizedCount`, `issueSummarizedCount`, `issuesToSummarize`), returned verbatim by `POST /admin/backfill` (`src/routes.ts` — unchanged, it already returns the whole result object).
- Produces: `AppState.backfillSync` carries both PR and issue progress; the Sync modal renders two bars.

- [ ] **Step 1: Write the failing tests**

In `test/render.mywork.test.ts`, replace the `"shows a disabled Sync button..."` test's state literal:

```ts
    const s = { ...stateWithDashboard(data, true), backfillSync: { structuredCount: 66, prsTotal: 146 } };
```

with:

```ts
    const s = { ...stateWithDashboard(data, true), backfillSync: { prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } };
```

Replace the `"renders a centered progress modal with the current X of Y count..."` test entirely with:

```ts
  it("renders two progress bars — PRs and issues — while backfillSync is set", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } };
    const html = render(s);
    expect(html).toContain("66 of 146 PRs summarized");
    expect(html).toContain("width:45%"); // Math.round(66/146*100)
    expect(html).toContain("3 of 10 issues summarized");
    expect(html).toContain("width:30%"); // Math.round(3/10*100)
  });
```

In the `"renders no progress modal when backfillSync is null"` test, change the assertion text to match the new modal heading:

```ts
    expect(html).not.toContain("Syncing GitHub");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: FAIL — TypeScript rejects the `backfillSync` literal (extra fields not on the current type) and the two-bar assertions don't match the current single-bar modal.

- [ ] **Step 3: Update `web/src/render.ts`**

Change the `AppState.backfillSync` type:

```ts
  /** ADMIN Sync GitHub progress — null when idle; present while a (possibly
   *  multi-batch) sync is running, tracking cumulative counts across batches. */
  backfillSync: { prSummarizedCount: number; prsTotal: number; issueSummarizedCount: number; issuesTotal: number } | null;
```

Replace `backfillSyncModal`:

```ts
// Centered modal shown for the duration of an admin Sync GitHub run (possibly
// several batched requests — src/tools/backfill.ts caps AI calls per
// invocation, shared across PRs and issues). Both counts are absolute
// snapshots from the most recent batch, not accumulated client-side, so the
// bars always reflect real server-side state.
function backfillSyncModal(sync: { prSummarizedCount: number; prsTotal: number; issueSummarizedCount: number; issuesTotal: number }): string {
  const prPct = sync.prsTotal > 0 ? Math.round((sync.prSummarizedCount / sync.prsTotal) * 100) : 0;
  const issuePct = sync.issuesTotal > 0 ? Math.round((sync.issueSummarizedCount / sync.issuesTotal) * 100) : 0;
  const bar = (label: string, count: number, total: number, pct: number) => `
      <div style="font-size:12.5px;color:var(--fg-55);margin:0 0 6px">${count} of ${total} ${label}</div>
      <div style="height:8px;border-radius:999px;background:var(--hover);overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:999px;transition:width .3s ease"></div>
      </div>`;
  return `<div style="position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
    <div style="width:360px;border:1px solid var(--border-strong);border-radius:14px;padding:28px 30px;background:var(--bg);box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="animation:cnpy-spin .8s linear infinite;margin-bottom:14px"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">Syncing GitHub</div>
      ${bar("PRs summarized", sync.prSummarizedCount, sync.prsTotal, prPct)}
      ${bar("issues summarized", sync.issueSummarizedCount, sync.issuesTotal, issuePct)}
    </div>
  </div>`;
}
```

- [ ] **Step 4: Update `web/src/api.ts`**

```ts
export function adminBackfill(): Promise<{
  ok: boolean;
  captured: number;
  unchanged: number;
  summarized: number;
  summaryBudgetExhausted: boolean;
  prSummarizedCount: number;
  issueSummarizedCount: number;
  prs: number;
  issues: number;
  issuesToSummarize: number;
}> {
  return postJson("/admin/backfill", {});
}
```

- [ ] **Step 5: Update `web/src/main.ts`**

Change the comment above `runAdminBackfillLoop` (currently mentions `structuredCount/prsTotal`):

```ts
// Drives a (possibly multi-batch) Sync GitHub run: the backend caps AI calls
// per invocation (src/tools/backfill.ts's summaryBudgetExhausted), so this
// keeps calling adminBackfill() while a budget was exhausted, updating
// state.backfillSync after every batch — both PR and issue counts are
// absolute snapshots from the response, not accumulated here, so the modal's
// progress bars always reflect real server-side state. MAX_BACKFILL_BATCHES
// is a client-side backstop against spinning forever if summaries never
// converge (e.g. every AI call keeps falling back to excerpt).
```

Inside `runAdminBackfillLoop`, change:

```ts
      state.backfillSync = { structuredCount: last.structuredCount, prsTotal: last.prs };
```

to:

```ts
      state.backfillSync = {
        prSummarizedCount: last.prSummarizedCount,
        prsTotal: last.prs,
        issueSummarizedCount: last.issueSummarizedCount,
        issuesTotal: last.issuesToSummarize,
      };
```

And the placeholder set on dispatch:

```ts
      state.backfillSync = { structuredCount: 0, prsTotal: 0 }; // real counts land after the first batch resolves
```

to:

```ts
      state.backfillSync = { prSummarizedCount: 0, prsTotal: 0, issueSummarizedCount: 0, issuesTotal: 0 }; // real counts land after the first batch resolves
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Run the full suite + typecheck + web build**

Run: `npx vitest run` then `npm run typecheck` then `npm run build:web`
Expected: all green, web build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web/src/render.ts web/src/api.ts web/src/main.ts test/render.mywork.test.ts
git commit -m "$(cat <<'EOF'
feat(web): two progress bars in the Sync GitHub modal

The Sync modal tracked only PR summarization (structuredCount/prsTotal).
Now that Sync also summarizes issues (src/tools/backfill.ts), it shows
"N of M PRs summarized" and "N of M issues summarized" as two
independent bars.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: CLAUDE.md — describe the new issue-summary capture

**Files:**
- Modify: `/home/andresl/Projects/context/CLAUDE.md`

**Interfaces:**
- Consumes: nothing (docs-only).
- Produces: an accurate description of My Work's issue-summary capture, replacing the now-false "Issues are never summarized" line.

- [ ] **Step 1: Update the My Work paragraph**

In the "Roadmap & My Work" section, find this paragraph:

```
**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events: two separate lists — `previousActivity` (summarized merged/closed PRs where the person is the
subject, 5 most recent) and `todo` (their open assigned issues) — built from `events` (+ `pr_summaries`,
`people`), no live GitHub. `person` resolves via the `people` identity map; an unmapped login yields an
empty projection (`degraded:false`); any D1 failure yields empty `degraded:true` — never a 500. Completed
PRs are summarized ONCE, at capture time (`tools/summarize.ts`: Workers AI `env.AI`, deterministic excerpt
fallback), stored in `pr_summaries` and regenerable — never truth, never generated at render. Issues are
never summarized.
```

Replace it with:

```
**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events: two separate lists — `previousActivity` (summarized merged/closed PRs where the person is the
subject, 5 most recent) and `todo` (their open assigned issues, each carrying its own stored summary) —
built from `events` (+ `pr_summaries`, `issue_summaries`, `people`), no live GitHub. `person` resolves via
the `people` identity map; an unmapped login yields an empty projection (`degraded:false`); any D1 failure
yields empty `degraded:true` — never a 500. Completed PRs and assigned issues are each summarized ONCE, at
capture time (`tools/summarize.ts`: Workers AI `env.AI`, deterministic excerpt fallback), stored in
`pr_summaries` / `issue_summaries` respectively and regenerable — never truth, never generated at render.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: describe the issue-summary capture in CLAUDE.md

"Issues are never summarized" is no longer true — update My Work's
description to match the new issue_summaries capture path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Full-suite verification + manual real-example prompt check

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: confidence the whole slice is green, plus a manual sanity check of both prompts against real Workers AI (since `cloudflare:test` has no AI mock — this can't be automated).

- [ ] **Step 1: Full automated verification**

Run, in order:

```bash
npm run typecheck
npm test
npm run build:web
```

Expected: all three succeed with no errors.

- [ ] **Step 2: Manual real-example check against the live Workers AI binding**

This step can't be automated (no `AI` mock in the test pool — see Global Constraints), so it's done by hand against a running `wrangler dev`:

```bash
npm run build:web
npx wrangler dev
```

In a second terminal, use the existing backfill script (`scripts/backfill-events.mjs`) against a repo with a mix of PR/issue shapes, or hand-craft a couple of signed deliveries the same way `test/webhook.test.ts` does, POSTed at `http://localhost:8787/webhook/github` with `GITHUB_WEBHOOK_SECRET` matching `.dev.vars`. Cover at minimum:

- A merged PR with a rich, detailed body → confirm the stored `pr_summaries` row (`npx wrangler d1 execute canopy --local --command "SELECT * FROM pr_summaries ORDER BY created_at DESC LIMIT 1"`) reads as 2-3 sentences of plain prose leading with the concrete change, no headings.
- A merged PR with a bare/empty body → confirm the stored summary is the title verbatim (excerpt fallback engaging correctly is fine; if Workers AI answers instead, confirm it didn't pad or invent detail beyond the title).
- An assigned issue with a well-scoped, actionable body → confirm the stored `issue_summaries` row (`npx wrangler d1 execute canopy --local --command "SELECT * FROM issue_summaries ORDER BY created_at DESC LIMIT 1"`) states what the issue is AND what needs doing.
- An assigned issue with a vague, one-line body → confirm the stored summary is a plain restatement ONLY — no invented plan, next step, or scope beyond what the issue itself states.

If any case reads as padded, invents detail, or (for the vague issue) fabricates a plan, revisit the relevant prompt constant in `src/tools/summarize.ts` and re-run this check — do not ship on a failing manual check.

- [ ] **Step 3: Confirm the full task list is done**

Re-read this plan file top to bottom; every checkbox should be checked. If anything was skipped or deferred, say so explicitly rather than silently marking it done.
