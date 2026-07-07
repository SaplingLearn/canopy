# Structured My Work summaries: worker-generated fields for the option-2a cards

Date: 2026-07-06

## Problem

The My Work cards were redesigned (design handoff:
`sapling/frontend/design_handoff_mywork_cards`, option 2a — already componentized in
`web/src/render.ts`) around labeled section rows that need **worker-generated
structured fields** that don't exist today:

- **PR card**: humanized title, "What changed", "Why", "Impact" (plain-language
  outcome, not a file list), footer "into `<base branch>`".
- **To-do (issue) card**: humanized title, "Summary", "Milestone" (title + due date),
  "Next step" (only when the issue actually states/implies one).

Today both summarizers emit 2–3 sentences of **plain prose** (the 2026-07-04 design),
`pr_summaries`/`issue_summaries` each store a single `summary` TEXT column, and the
captured event `raw` lacks the milestone title/due date (issues) and `base.ref` (PRs).
The old `**What changed:**/**Why:**` markdown convention (`shared/prSummary.ts`) is a
regex over free text that already broke once when the prompt changed — it is not the
way back to structure.

Chosen approach (user-approved, "A"): **real columns + JSON model output** —
structure is parsed and validated once, at capture time, where the write happens;
the render path never parses anything.

## Design

### 1. Summarizer output shapes (`src/tools/summarize.ts`)

Both prompts are rewritten to demand a **single strict JSON object, no code fences,
no preamble**:

- PR: `{ "title": string, "what": string, "why": string | null, "impact": string | null }`
- Issue: `{ "title": string, "summary": string, "next_step": string | null }`

Field rules (carried over from the current prompts' grounding discipline):

- `title` — a short, humanized, sentence-case rewrite of what the PR/issue is about
  (the wireframe register: "Reconcile drops events when webhook retries overlap"),
  grounded only in the real title+body; never invents scope. Display sugar — the raw
  GitHub title remains the stored truth on the event.
- PR `what` — lead with the concrete change that shipped; `why` — motivation, null
  when the body doesn't state one; `impact` — one user-facing outcome sentence
  (explicitly NOT files touched), null when the body doesn't support one.
- Issue `summary` — plain restatement grounded in title+body; `next_step` — only
  where the issue states or clearly implies an action, **else null — never an
  invented plan** (same rule as today, now expressed as a nullable field instead of
  prose restraint).

Parsing/validation happens in the summarizer wrapper (never throws):
strip an accidental ```json fence, `JSON.parse` in try/catch, then shape-check —
required string fields non-empty after trim, nullable fields coerced `"" → null`,
non-string → failure. Any failure → `null` → the existing excerpt fallback. The
`Summarizer` interface becomes typed per output:
`interface Summarizer<T> { model: string; summarize(input): Promise<T | null> }`
with `PrSummary` / `IssueSummary` output types; DI stubs in tests update to return
objects instead of strings.

### 2. Storage (`migrations/0018_structured_summaries.sql`, `shared/rows.ts`)

Nullable columns via `ALTER TABLE` (one statement per column, D1/SQLite):

- `pr_summaries` + `title`, `what`, `why`, `impact` (all TEXT NULL)
- `issue_summaries` + `title`, `next_step` (TEXT NULL)

The existing `summary` column stays NOT NULL and keeps meaning "prose to show when
structure is absent": on structured success, `storePrSummary` writes `summary = what`
(sane prose for any reader of the old column) and `storeIssueSummary` writes
`summary = <structured summary field>` (they're the same thing for issues). On
fallback, exactly today's behavior: `summary = excerptSummary(...)`,
`model = 'excerpt'`, all structured columns NULL. `PrSummaryRow` / `IssueSummaryRow`
gain the nullable fields. `test/apply-migrations.ts` needs no new table entries
(same tables, new columns).

### 3. Capture widening (`src/webhook.ts`, `src/tools/backfill.ts`)

Both payload shapes already carry what we need — no new GitHub calls:

- Issue `raw.issue.milestone` gains `title` and `due_on` (keeping
  `number`/`open_issues`/`closed_issues`); `GhMilestone` widened in both files.
- PR `raw.pr` gains `base: { ref } | null` (`GhPullRequest` / the backfill PR list
  item gain `base?: { ref: string }`).
- Fixtures (`test/fixtures/gh-issue-*.json`, backfill fixtures) gain the fields.

Known lag, accepted: events are immutable (deduped by `semantic_key`, written
`INSERT OR IGNORE`), so an already-captured issue snapshot keeps its old `raw` (no
milestone title) until the issue is next updated, and an already-captured PR close
event never gains `base.ref` — the Milestone row / "into `main`" suffix simply hide
for those rows. Nothing is re-fetched at render.

### 4. Read side (`src/tools/mywork.ts`, `shared/dashboard.ts`)

`getMyWork` projects the new columns; no shape parsing anywhere:

- `MyWorkPr`: `displayTitle = s.title`, `impact = s.impact`, and **new DTO fields
  `what: string | null`, `why: string | null`** from the columns;
  `baseRef = raw.pr.base?.ref ?? null`.
- `MyWorkTodo`: `displayTitle = s.title`, `nextStep = s.next_step`,
  `milestone = raw.issue.milestone?.title ? { title, dueOn: due_on ?? null } : null`.

The web render then reads `pr.what`/`pr.why` directly; when `what` is null it falls
back to the single "Summary" prose row (already implemented). This deletes
`shared/prSummary.ts`, its test, and the `parseStructuredSummary` call in
`web/src/render.ts` — old marker-convention rows render as a prose Summary row until
Sync regenerates them (see §5). The temporary `web/src/mock.ts` preview layer and its
call site are deleted in the same wiring change.

### 5. Sync/backfill regeneration (`src/tools/backfill.ts`)

"Already summarized" is redefined from `model !== 'excerpt'` to
`model !== 'excerpt' AND title IS NOT NULL` (both loops) — `title` doubles as the
structured-generation marker, so every prose-era AI summary regenerates exactly once
under the existing shared budget/pacing, and excerpt rows keep retrying for a real
summary as they do today. Counter names (`prSummarizedCount`,
`issueSummarizedCount`) and the two Sync progress bars are unchanged.

### 6. CLAUDE.md

Update the My Work paragraph: summaries are structured (PR: title/what/why/impact;
issue: title/summary/next_step), JSON-validated at capture time, stored as columns on
`pr_summaries`/`issue_summaries` with the excerpt fallback writing prose-only rows —
still generated once at capture, regenerable, never truth.

## Testing

- `test/summarize.test.ts`: prompt content assertions (strict-JSON instruction, the
  never-invent-next-step rule, impact-not-files rule); parse/validate unit cases —
  valid JSON, fenced JSON, malformed JSON, wrong-typed fields, empty required field →
  fallback; store fns write columns + `summary` mirror on success and NULL columns +
  excerpt on fallback.
- `test/webhook.test.ts` + fixtures: milestone title/due_on and base.ref land in `raw`.
- `test/backfill.test.ts`: prose-era row (`model` set, `title` NULL) regenerates;
  structured row skips; excerpt row retries; shared budget still PR-first.
- `test/mywork.test.ts`: projection carries the six new field values from
  columns/raw; nulls flow when absent.
- `test/render.mywork.test.ts`: What changed/Why from DTO fields (not parsed);
  prose fallback row; mock layer tests removed with the mock.
- Live-prompt check stays manual against the real `AI` binding (existing constraint:
  no AI mock in the vitest pool) — a rich PR, a bare-title PR, a well-scoped issue,
  and a vague one-liner; verify the vague issue yields `next_step: null`.

## Out of scope

- **No summarizer queue.** The mock/wireframe copy mentions one — that's design
  fiction for the card, not a commitment; summarization stays inline at capture time
  (the Queue seam remains a `// SEAM:` comment).
- No new GitHub calls, no render-time generation, no change to which events are
  captured or which actions trigger a summary (`assigned` only for issues).

## Wiring up the frontend (final step of this slice)

The option-2a cards and the temporary mock layer are already in the tree
(uncommitted on `feat/todo-summaries`), so this slice finishes by swapping the cards
from mock/parsed data onto the real projection — it does not ship as a separate
follow-up:

1. **DTO** — `MyWorkPr` gains `what: string | null` and `why: string | null`
   (`displayTitle`/`impact`/`baseRef` and the `MyWorkTodo` fields already exist from
   the componentization).
2. **Projection** — `getMyWork` replaces the six `null` placeholders in
   `src/tools/mywork.ts` with the real values per §4 (summary-table columns +
   widened `raw` fields).
3. **Render** — `prActivityCard` reads `pr.what`/`pr.why` directly; `what === null`
   falls back to the existing single "Summary" prose row (`pr.summary`), and
   `pr.summary === null` keeps the muted no-summary line. No parsing anywhere.
4. **Deletions** — `shared/prSummary.ts` + `test/prSummary.test.ts` (the regex
   convention), and `web/src/mock.ts` + its one call site in `web/src/main.ts` +
   `test/mock.mywork.test.ts` (the preview layer).
5. **Tests** — `test/render.mywork.test.ts` asserts What changed/Why from the DTO
   fields (structured → rows, null `what` → Summary fallback);
   `test/mywork.test.ts` asserts the real projections replace the placeholders.
6. **Verify end-to-end** — `npm test`, `npm run typecheck`, `npm run build:web`,
   then a manual pass on `wrangler dev`: run a Sync so prose-era rows regenerate,
   confirm both cards render their structured rows from real data and that
   null-field rows (no milestone, no next step, no impact) collapse.
