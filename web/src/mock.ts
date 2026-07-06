// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY design-preview mocks — DELETE THIS FILE and its ONE call site
// (loadMyWork in web/src/main.ts) when the structured-summary backend lands.
//
// The My Work cards (todoCard / prActivityCard) were rebuilt around new nullable
// DTO fields (displayTitle, milestone, nextStep, impact, baseRef — see
// shared/dashboard.ts) that the backend still returns as null. Until that slice
// ships, this layer decorates the /me/dashboard response so the page shows the
// fully-populated design: it fills ONLY null fields on real items and injects
// one canonical wireframe card per list when a list is empty. Nothing here is
// truth — it never touches the backend and must never be persisted.
// ─────────────────────────────────────────────────────────────────────────────
import type { DashboardData, MyWorkPr, MyWorkTodo } from "@shared/dashboard";

export const MYWORK_MOCKS_ENABLED = true;

const MOCK_MILESTONE: NonNullable<MyWorkTodo["milestone"]> = { title: "Reliable event capture", dueOn: "2026-07-20" };
const MOCK_NEXT_STEP = "Add a per-ref delivery lock in `consumer.ts` before the reconcile write.";
const MOCK_IMPACT = "Issue summaries now show up on the dashboard within a minute of a change, and big syncs no longer stall the rest of the pipeline.";
const MOCK_BASE_REF = "main";

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/** The canonical wireframe todo card, injected only when the real list is empty. */
function mockTodo(): MyWorkTodo {
  return {
    number: 142,
    title: "Reconcile drops events when webhook retries overlap",
    displayTitle: "Reconcile drops events when webhook retries overlap",
    priority: "P1",
    labels: ["bug", "consumer", "webhook"],
    url: "https://github.com/SaplingLearn/sapling/issues/142",
    updatedAt: hoursAgo(5),
    summary: "Overlapping webhook redeliveries can race the reconcile pass, so the newer snapshot loses and an event lands twice in the feed.",
    milestone: { ...MOCK_MILESTONE },
    nextStep: MOCK_NEXT_STEP,
  };
}

/** The canonical wireframe PR card, injected only when the real list is empty.
 *  The summary follows the "**What changed:** … **Why:** …" convention
 *  (shared/prSummary.ts) so prActivityCard renders the two labeled rows. */
function mockPr(): MyWorkPr {
  return {
    number: 138,
    title: "Route issue summaries through the summarizer queue",
    displayTitle: "Route issue summaries through the summarizer queue",
    url: "https://github.com/SaplingLearn/sapling/pull/138",
    merged: true,
    occurredAt: hoursAgo(48),
    summary: "**What changed:** Issue events now enqueue a summarize job instead of calling the model inline; summaries land in `issue_summaries` keyed by number.\n\n**Why:** Inline model calls blocked webhook ACKs and hit rate limits during backfills.",
    impact: MOCK_IMPACT,
    baseRef: MOCK_BASE_REF,
  };
}

/** Pure decoration over the /me/dashboard payload (never mutates the input):
 *  fills ONLY the fields that are null on real items (displayTitle stays null so
 *  the render falls back to the real GitHub title), and injects the canonical
 *  wireframe card into a list only when that list is empty. `person` passes
 *  through untouched — myWorkView never branches on it (the greeting comes from
 *  state.me), so the cards show without a placeholder. */
export function applyMyWorkMocks(data: DashboardData): DashboardData {
  const todo: MyWorkTodo[] = data.todo.length === 0
    ? [mockTodo()]
    : data.todo.map((t) => ({
        ...t,
        milestone: t.milestone ?? { ...MOCK_MILESTONE },
        nextStep: t.nextStep ?? MOCK_NEXT_STEP,
      }));
  const previousActivity: MyWorkPr[] = data.previousActivity.length === 0
    ? [mockPr()]
    : data.previousActivity.map((pr) => ({
        ...pr,
        impact: pr.impact ?? MOCK_IMPACT,
        baseRef: pr.baseRef ?? MOCK_BASE_REF,
      }));
  return { ...data, todo, previousActivity };
}
