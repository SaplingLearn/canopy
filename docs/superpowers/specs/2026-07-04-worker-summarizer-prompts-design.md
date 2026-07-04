# Worker summarizer prompts: richer PR summaries, new issue summaries

Date: 2026-07-04

## Problem

My Work shows two lists: "Previous activity" (completed PRs) and "To-do" (open
assigned issues). Only PRs are summarized today (`src/tools/summarize.ts`,
`storePrSummary`) — issues render with no summary at all. The PR prompt itself is
also too thin: `SUMMARIZER_SYSTEM_PROMPT` asks for a terse `**What changed:**
/ **Why:**` two-field structure that doesn't convey what actually shipped or why it
mattered.

The target behavior (full spec in the `canopy-worker-summarizer-prompts.md` note
this design is based on):

- PR summarizer (previous activity): richer, 2-3 sentences of plain prose — lead with
  the concrete change, include meaningful detail (behavior changed, what it fixes or
  enables, caveats), stay entirely inside the PR body.
- Issue summarizer (to-do), new: 2-3 sentences — a plain restatement of what the issue
  is, plus what it needs doing *only* where the issue actually states or clearly
  implies an action. A vague issue gets a plain restatement, never an invented plan.
- Shared style: plain prose, no headings/bullets/preamble, output the summary text
  only, empty/thin body falls back to the title.

Two things fall out of that change that the note doesn't address, surfaced and
resolved with the user before this design:

1. **The PR summarizer moving to plain prose breaks `src/tools/backfill.ts`'s Sync
   feature.** Today `runBackfill` skips re-summarizing a PR when
   `parseStructuredSummary(existing.summary) !== null`, and the same check drives
   `structuredCount` — the "X of Y PRs summarized" progress bar in the Sync modal
   (`web/src/render.ts`, `backfillSyncModal`). Once the prompt stops emitting the
   `**What changed:**/**Why:**` markers, every future summary permanently fails that
   check: every Sync would re-summarize every closed PR again, and the progress bar
   would never advance. **Resolved:** redefine "already summarized" as
   `model !== 'excerpt'` and rename `structuredCount` throughout (it would otherwise
   describe something that no longer exists).
2. **"Issue summarizer... written by the issue summarizer... read by the to-do
   list" needs storage that doesn't exist.** There's no `issue_summaries` table and
   `MyWorkTodo` has no `summary` field — CLAUDE.md's My Work section currently
   documents "Issues are never summarized" as the design. **Resolved:** build the full
   vertical slice (migration, DTO, wiring, `getMyWork` join, CLAUDE.md update) rather
   than stopping at the prompt.

The user also asked that Sync's AI-call rate-limit budget (20 calls/run, existing
guard against an observed hard wall under sustained load) be **shared** across PR and
issue summarization rather than doubled, and that the Sync modal show **two**
separate progress bars (PRs, issues).

## Design

### 1. Schema: `issue_summaries` (new migration `0017_issue_summaries.sql`)

```sql
CREATE TABLE issue_summaries (
  issue_number INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL
);
```

Keyed by issue number, not `semantic_key` — unlike a PR (which merges/closes once),
an issue's `semantic_key` changes on every reassignment/edit
(`gh:issue:{number}:{action}:{assignee}:{updated_at}`), but only the *current*
summary matters for the to-do list. `INSERT OR REPLACE` on every newly-captured
assigned-issue event, mirroring `pr_summaries`'s "derived, regenerable, never truth"
posture. No FK to `events` (no stable 1:1 semantic_key to reference).

`shared/rows.ts` gains:

```ts
export interface IssueSummaryRow {
  issue_number: number;
  summary: string;
  model: string | null;
  created_at: string;
}
```

### 2. Capture gap: issue events don't carry `body`

Neither `eventsFromDelivery`'s issue branch (`src/webhook.ts`) nor `backfill.ts`'s
`issueDelivery` capture `issue.body` today — nothing needed it before this. Both the
GitHub webhook payload and the REST issues-list response already include it, so this
is purely widening the existing capture, not a new GitHub call:

- `GhIssue` (`src/webhook.ts`) and `GhIssueListItem` (`src/tools/backfill.ts`) gain
  `body: string | null`.
- The `raw` JSON built in both places includes `body`.
- Test fixtures (`test/fixtures/gh-issue-assigned.json` and any backfill issue
  fixtures) gain a `body` field.

### 3. Prompts (`src/tools/summarize.ts`)

Rewrite `SUMMARIZER_SYSTEM_PROMPT` (PR) to the richer plain-prose form: 2-3 sentences,
lead with the concrete change, include meaningful detail and caveats the body
supports, no headings, stay entirely inside the body. Add
`ISSUE_SUMMARIZER_SYSTEM_PROMPT`: 2-3 sentences, plain restatement of what the issue
is plus what it needs doing *only* where the issue supports it, otherwise stop at the
restatement — explicitly instructed not to invent a plan for a vague issue.

Both prompts are fed through one parameterized summarizer:

```ts
function makeWorkersAiSummarizer(ai: Ai, systemPrompt: string): Summarizer { ... }
export function workersAiPrSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, SUMMARIZER_SYSTEM_PROMPT);
}
export function workersAiIssueSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, ISSUE_SUMMARIZER_SYSTEM_PROMPT);
}
```

`workersAiSummarizer` (the current PR-only export) is replaced by
`workersAiPrSummarizer` at all call sites (`src/webhook.ts`, `src/tools/backfill.ts`).
`excerptSummary`'s existing fallback (thin/empty body → title verbatim, else a 280-char
collapsed excerpt) already matches the spec's fallback rule for *both* prompts —
reused as-is, no issue-specific fallback needed.

New `storeIssueSummary`, mirroring `storePrSummary`:

```ts
export async function storeIssueSummary(
  db: DB,
  summarizer: Summarizer | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow>
```

Same never-throws contract: any summarizer failure (throw/null/empty) falls back to
`excerptSummary`, `model` records `'excerpt'` on fallback.

### 4. Wiring: webhook capture (`src/webhook.ts`)

`handleGithubWebhook`'s per-event branch currently reads:

```ts
if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
  await summarizePrSeam(...)
} else {
  await progressSeam(...)
}
```

Every issue event already runs `progressSeam`. Add a second, independent seam that
also runs when the captured action is `"assigned"` (parsed off `event.raw` — action
isn't distinguishable from `event_type` alone, which is just `"issue"` for every issue
action):

```ts
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

Called alongside (not instead of) `progressSeam` for every newly-written issue event —
unassigned/opened/closed issue events still only update progress.

`handleGithubWebhook`'s `opts` parameter gains `issueSummarizer?: Summarizer | null`
(mirroring the existing `summarizer` field), resolved the same way —
`opts?.issueSummarizer ?? (env.AI ? workersAiIssueSummarizer(env.AI) : null)` — and
passed into `summarizeIssueSeam`, so tests can inject a stub exactly like the PR path
does today.

### 5. Wiring + fixes: `src/tools/backfill.ts`

**PR skip-check fix.** Replace `parseStructuredSummary(existing.summary) !== null`
with `existing !== null && existing.model !== 'excerpt'`. Rename `structuredCount` →
`prSummarizedCount` throughout (`BackfillResult`, the running counter, `web/src/api.ts`,
`web/src/main.ts`, `web/src/render.ts`, and tests) — the old name would describe a
format that no longer exists.

`runBackfill`'s `opts` gains `issueSummarizer?: Summarizer | null`, resolved the same
way as the existing `summarizer` (`opts?.issueSummarizer ?? (env.AI ?
workersAiIssueSummarizer(env.AI) : null)`), so tests can inject a stub for the issue
path independently of the PR path.

**Issue summarization added to the issue loop**, mirroring the PR loop's
resummarize-unless-done / budget-check / call / pace pattern, but only for issues that
currently have an assignee (i.e. `issueDelivery` produced action `"assigned"` —
unassigned open issues never appear in anyone's to-do, so never need a summary):

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
      await applyEventProgress(env.DB, payload);
    } else {
      unchanged++;
    }

    if (!isAssigned) continue;

    const existing = await first<IssueSummaryRow>(
      env.DB, `SELECT model FROM issue_summaries WHERE issue_number = ?`, issue.number
    );
    if (existing !== null && existing.model !== 'excerpt') {
      issueSummarizedCount++;
      continue;
    }
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
```

**Shared budget.** `summarized` and `summaryBatchLimit` are the same counter/cap used
by the PR loop above it — no separate issue budget. Because the PR loop runs first
(unchanged order), a large backlog spends the whole budget on PRs before any issue
gets summarized; once PRs converge (steady state — a handful of newly-closed PRs and
newly-assigned issues per Sync), both get covered in one run. Accepted as the natural
consequence of a shared budget, not special-cased.

`BackfillResult` becomes:

```ts
export interface BackfillResult {
  ok: boolean;
  error?: string;
  captured: number;
  unchanged: number;
  summarized: number;            // total AI-summarizer calls this run (PR + issue combined)
  summaryBudgetExhausted: boolean;
  prSummarizedCount: number;     // was structuredCount
  issueSummarizedCount: number;  // new
  prs: number;                   // unchanged: total closed PRs found
  issues: number;                // unchanged: total open issues found
  issuesToSummarize: number;     // new: of those, how many are currently assigned
}
```

### 6. Read side: `getMyWork` (`src/tools/mywork.ts`, `shared/dashboard.ts`)

`MyWorkTodo` gains `summary: string | null`. `getMyWork`'s issue query left-joins
`issue_summaries` on `ref_number = issue_summaries.issue_number`, mirroring the
existing `pr_summaries` join used for `previousActivity`:

```sql
SELECT ref_number, raw, s.summary AS summary FROM (
  SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
  FROM events WHERE event_type = 'issue'
) e LEFT JOIN issue_summaries s ON s.issue_number = e.ref_number
WHERE rn = 1
ORDER BY ref_number ASC
```

### 7. UI: two progress bars (`web/src/render.ts`, `web/src/main.ts`, `web/src/api.ts`)

`adminBackfill()`'s return type (`web/src/api.ts`) picks up the renamed/new
`BackfillResult` fields. `state.backfillSync` (`web/src/main.ts`) carries both pairs:

```ts
{ prSummarizedCount: number; prsTotal: number; issueSummarizedCount: number; issuesTotal: number }
```

`backfillSyncModal` (`web/src/render.ts`) renders two labeled bars instead of one —
"N of M PRs summarized" and "N of M issues summarized" — each with its own percentage
fill, stacked in the existing modal.

### 8. CLAUDE.md

The My Work section's "Issues are never summarized" line is now wrong. Update it to
describe issue summaries alongside PR summaries: generated once at capture time (on
`assigned` events), stored in `issue_summaries`, regenerable, never truth — same
posture, parallel table.

## Testing

- `test/summarize.test.ts`: content assertions for both system prompts (no headings,
  plain-prose framing); `storeIssueSummary` unit tests mirroring `storePrSummary`'s
  stub/null/throw/no-summarizer cases.
- `test/backfill.test.ts`: update existing `structuredCount`-based assertions to
  `prSummarizedCount` / `model !== 'excerpt'` semantics. New cases: an assigned issue
  gets summarized and skipped on the next run once done; an unassigned/opened issue is
  never summarized; the shared budget is consumed by PRs before issues when both have
  backlog.
- `test/mywork.test.ts` (or wherever `getMyWork` is covered): `todo[].summary` comes
  from the `issue_summaries` join; null when no summary exists yet.
- `test/render.mywork.test.ts`: update `backfillSync` state shape in tests; assert the
  modal renders two independent bars/percentages.
- `test/apply-migrations.ts`: add `DELETE FROM issue_summaries;` to the truncation
  list.
- Real-example check (per the source note's "check before shipping" step): Workers AI
  has no test-pool mock (existing constraint — GitHub I/O and the summarizer are
  dependency-injected specifically because vitest can't stub `env.AI`), so validating
  both prompts against a rich PR body, a bare-title PR, a well-scoped issue, and a
  vague one-line issue happens by hand against the live `AI` binding (`wrangler dev` or
  the Workers AI REST API), not in the automated suite.

## Out of scope

- No change to `web/src/render.ts`'s PR/issue card rendering beyond the Sync modal —
  `prActivityCard`'s existing `parseStructuredSummary`-or-plain-prose branch already
  degrades new plain-prose PR summaries to its "not matched → plain prose" path with
  no code change; todo cards pick up `summary` in a follow-up if/when the to-do list
  itself needs to display it (this design only makes the data available end-to-end).
- No resumable/bounded backfill cursor beyond the existing shared batch limit.
- No change to which issue actions get captured as events (`ISSUE_ACTIONS` in
  `src/webhook.ts` is unchanged) — only which captured actions additionally trigger a
  summary (`"assigned"` only).
