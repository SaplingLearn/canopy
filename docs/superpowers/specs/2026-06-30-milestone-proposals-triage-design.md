# Milestone proposals in Triage — design

**Date:** 2026-06-30
**Status:** approved, ready to implement

## Problem

Canopy's staged→confirm loop covers four entity types: docs, ADRs, needs-triage
items, and milestones. Three are wired end-to-end. Milestones are wired
*everywhere except the frontend UI*:

- Gate stages `propose_milestone` → `milestone_proposals` row (`staged_status='staged'`).
- Worker: `GET /milestone-proposals` (`routes.ts:86`) and `POST /milestone-proposals/:id/promote` (`routes.ts:212`).
- API client: `listMilestoneProposals` + `promoteMilestoneProposal` already exist in `web/src/api.ts`.
- **Frontend: nothing.** `main.ts` never calls those functions; `render.ts` has no queue. The Triage screen has exactly three queues; the Roadmap shows only live milestones.

Net effect: an agent's `propose_milestone` stages a row that is invisible and
un-promotable in the app — the only way to promote it is a manual `curl`. This
spec closes that gap.

Separately, milestone proposals support only **promote** on the backend — there
is no reject route (docs and ADRs both have one). We add it for consistency.

## Decisions

- **Placement:** a 4th Triage queue, "Milestones", alongside Proposals /
  Decisions / Triage. Most consistent — all staged-confirm work in one place,
  reusing the existing queue layout and selection model.
- **Scope:** Promote **and** Reject. Add the missing backend reject route + a
  soft-reject so the queue behaves like Proposals and Decisions.

## Backend (mirrors the ADR reject path)

- `reject_milestone_proposal(db, id)` in `src/tools/writes.ts` — guard
  not-found; idempotent if already `'rejected'`; throw if `'promoted'`; else
  `UPDATE milestone_proposals SET staged_status='rejected' WHERE id=?`.
  Pattern-identical to `reject_adr` (`writes.ts:290`).
- `POST /milestone-proposals/:id/reject` in `src/routes.ts` — mirrors
  `/adr/:id/reject` (`routes.ts:132`). Session-gated, **never** an MCP tool.
- Widen `MilestoneProposalRow.staged_status` to
  `'staged' | 'promoted' | 'rejected'` in `shared/rows.ts`.

**No migration.** `staged_status` is free `TEXT NOT NULL DEFAULT 'staged'` (no
CHECK), and `list_milestone_proposals` already filters `WHERE
staged_status='staged'`, so a rejected proposal drops out of the queue
automatically — non-destructive, the row stays.

## Frontend (mirrors the Decisions queue)

- `web/src/api.ts`: add `rejectMilestoneProposal(id)`.
- `web/src/main.ts`:
  - extend the `triageQueue` union with `'milestones'`;
  - add `milestoneProps: Loadable<MilestoneProposalRow[]>` + `selMilestoneProp` to state;
  - `loadMilestoneProposals()` cloned from `loadDecisions`;
  - wire it into `loadCurrentTriageQueue()`;
  - `queueMilestones` nav handler; `promoteMilestone` and a milestones branch of
    the `dismiss` (reject) handler — each does the action, then `flash()` + reload.
- `web/src/render.ts`:
  - add the **Milestones** tab (with count) to the queue bar (~`render.ts:315`);
  - add a milestone detail pane in `triageView`: title, target date, confidence,
    `change_summary`, with **Reject** / **Promote** buttons (existing styles).
- Update the Get Started guide: "Three queues" → "Four queues" (`render.ts:1149`).

## Testing (Vitest + real Miniflare D1)

- Unit: `reject_milestone_proposal` — rejects a staged proposal (drops from
  `list_milestone_proposals`); idempotent on re-reject; refuses a promoted one.
- Route: `POST /milestone-proposals/:id/reject` — 200 + soft flip; 400 on bad id.
- Confirm promote still works; `npm run typecheck` clean.

## Isolation

The reject fn is one self-contained function beside `reject_adr`. The new queue
is additive — it touches the existing three queues only by adding a union member
and a tab.
