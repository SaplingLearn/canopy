# My Work: reorder, structured cards, retroactive summary resync

Date: 2026-07-03

## Problem

The My Work screen (`web/src/render.ts`, `myWorkView`) shows two sections: "Previous
activity" (merged/closed PRs) above "To-do" (open assigned issues). Two things are off:

1. To-do — the actionable list — renders below the read-only activity history. It
   should be on top.
2. Both sections are thin on structure. `todoCard` is a single truncated line with no
   room for a full title or an updated-at signal. `prActivityCard`'s body is one
   undifferentiated AI-generated prose blob — no labeled fields.

Separately, "Sync GitHub" (the admin-only backfill button) only looks at PRs closed in
the last 14 days, and only (re)generates a PR's summary when its event is *newly*
captured — an already-captured PR's summary is never touched again. That means
existing PRs would stay on the old unstructured prose format forever, even after this
change ships.

## Design

### 1. Reorder (`web/src/render.ts`, `myWorkView`)

Swap section composition from `${hero}${activity}${todo}` to `${hero}${todo}${activity}`.
Section labels ("To-do", "Previous activity") stay as-is.

### 2. To-do card restructure (`todoCard`)

From a single-line truncated row to a two-line card, still one `<a class="cnpy-card">`:

- Row 1: priority badge + `#number` + title. Title wraps up to 2 lines (CSS
  line-clamp) instead of single-line ellipsis truncation.
- Row 2: up to 3 labels (cap unchanged, keeps the card bounded) + a right-aligned
  relative "updated" timestamp from `t.updatedAt` (captured today, currently unused
  in the card).

### 3. Structured PR summaries

**New shared module `shared/prSummary.ts`** — the single source of truth for
recognizing the structured-summary convention, imported by both the Worker and the
web build:

```ts
export interface StructuredPrSummary {
  what: string;
  why: string | null;
}

export function parseStructuredSummary(raw: string): StructuredPrSummary | null;
```

It matches markdown of the shape:

```
**What changed:** <1-2 factual sentences>
**Why:** <1 sentence — omitted entirely when no rationale is stated>
```

Returns `null` when the text doesn't match (old-style prose, the deterministic
excerpt fallback, or a malformed AI response) — callers treat `null` as "render/treat
as plain prose," never as an error.

**Backend (`src/tools/summarize.ts`)** — `workersAiSummarizer`'s system prompt
changes to require exactly that two-field shape (omitting the `**Why:**` line when
the PR body states no rationale), instead of "2-3 short sentences." No signature
change. `excerptSummary` (the deterministic no-AI fallback) is untouched — it keeps
producing plain prose, which is intentional: a parse miss just falls back to today's
rendering, never a broken UI. `pr_summaries.summary` stays a single `TEXT` column; no
migration — the structure lives in the markdown convention, not the schema.

**Frontend (`web/src/render.ts`, `prActivityCard`)** — the summary body now branches
on `parseStructuredSummary(pr.summary)`:
- Matched → two labeled rows ("What changed", and "Why" only when present), each a
  small uppercase caption (scaled-down `MW_LABEL` idiom) above its markdown body.
- Not matched → today's single prose block, unchanged.

### 4. Retroactive resync (`src/tools/backfill.ts`, `runBackfill`)

Two independent changes to `runBackfill`:

**a. Full PR history.** Remove the `DAYS_BACK`/cutoff logic on the closed-PR fetch —
paginate through every closed PR the repo has, not just the last 14 days. The open-
issues fetch is untouched (it already has no window).

**b. Decouple summary (re)generation from event-capture outcome.** Today,
`storePrSummary` only runs inside `if (res.outcome === "written")` — i.e., only for
brand-new events. Change: for every PR in the fetched list (regardless of whether its
event was newly captured or already existed), look up its existing `pr_summaries` row
and call `storePrSummary` unless `parseStructuredSummary(existing.summary) !== null`
(i.e., skip only when it's already in the new structured format). `ev.raw` (built
before `ingestEvent` runs) always has the PR's title/body available regardless of the
event's write outcome, so no extra DB read is needed to get the summarizer input —
only one extra read (existing `pr_summaries` row) to decide skip-or-regenerate.

**c. Observability.** `BackfillResult` gains `summarized: number` — incremented each
time `storePrSummary` actually runs (not skipped). Threaded through:
- `src/routes.ts` `/admin/backfill` response (already returns the whole result object,
  no route change beyond the type flowing through).
- `web/src/api.ts` `adminBackfill()` return type.
- `web/src/main.ts`'s flash message: `Synced: ${r.captured} captured, ${r.unchanged}
  unchanged, ${r.summarized} summaries updated`.
- `web/src/render.ts`'s button title: "Fetch recent GitHub PRs + issues" →
  "Fetch all GitHub PRs + issues" (no longer just recent).

**Accepted limitation:** unbounded full-history pagination plus one AI call per
un-migrated PR has no hard cap or resumable cursor. Fine at this project's current
size (a first Sync after this ships does a one-time migration of every existing PR to
the structured format; later clicks are cheap since already-structured PRs are
skipped). Would need a real bound/cursor if the repo's PR history grows a lot —
explicitly not building that now (YAGNI).

## Testing

- `test/render.mywork.test.ts` (pure, no DOM): `todoCard` shows `updatedAt` and
  doesn't collapse a long title to one truncated line; `prActivityCard` renders two
  labeled rows for a structured summary (with and without a `why`), and falls back to
  the existing prose rendering for a non-conforming summary.
- New test file (or colocated in `test/summarize.test.ts`) for
  `shared/prSummary.ts`'s `parseStructuredSummary`: matches the two-field shape,
  matches "What changed" only (no "Why" line), returns `null` for old-style prose and
  for empty/malformed input.
- `test/backfill.test.ts`: the existing "oldPr excluded by the 14-day window"
  assertion is now wrong on purpose and must be updated to reflect full-history
  fetch. New cases: a PR with an existing non-structured summary gets re-summarized
  on a second run (`summarized` increments, `storePrSummary`/summarizer called
  again); a PR with an existing structured summary is skipped on a second run
  (`summarized` stays 0 for it, summarizer not called again — assert via a
  call-counting stub summarizer).
- No new migration, so `test/apply-migrations.ts` is untouched.

## Out of scope

- No change to the live webhook capture path (`src/webhook.ts`) — a real-time merge
  event only ever fires once, so the "already captured, skip" question doesn't arise
  there.
- No change to issue capture/backfill scope (already unbounded).
- No resumable/bounded backfill cursor for large repos (see accepted limitation
  above).
