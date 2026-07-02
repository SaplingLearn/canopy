# canopy-build-roadmap-mywork.md

## What this builds

Execute the rebuild of My Work and Roadmap. The design is in `canopy-rebuild-roadmap-mywork.md`; the current-state inventory and phased teardown order are in the teardown audit. This document is the execution authority: where it states a decision, that decision is settled, do not reopen it.

Scope is Phases 0, 1, 3, 4 of the teardown order. Phase 2 (retiring `milestone_proposals` and reworking triage-assign) is deferred to the triage pass, because triage-assign still materializes a milestone proposal (`writes.ts:408`) and what triage does with milestone-type items is not yet decided. Build everything else now; leave the proposals table and its triage coupling standing until then.

Posture is behavioral: file:line plus the command plus the output. No test that would stay green if the behavior were reverted. Verify current state before removing anything.

## Settled decisions (do not reopen)

1. `consume()` is an ingestion gate, not a universal write gate. It exists to police agent-proposed content (vocab, confidence, dedup, reconciliation). Authored and computed writes have always gone direct: `promote_milestone_proposal`, `complete_milestone`, `promote_doc` all write straight through cookie routes today. So the plan write path and the progress write path are direct writes in that same class. The invariant restated correctly: ingested content is gated; authored and computed writes are direct. This is not a loosening, it is the accurate statement.

2. My Work is purely captured GitHub events, no ROADMAP.md, no hand-maintained per-person phase, no focus. It is two explicitly separate lists off the same event stream, split by what they need. Previous activity is merged/closed PRs where the person is the subject, windowed to the last 14 days (completed PRs accumulate forever, so they must be bounded; assigned issues are self-limiting because they leave the list when closed). To-do is the open issues assigned to the person. Assignment and completion are different event types feeding different lists, and only the completion side is ever summarized.

3. The Worker summarizes completed PRs only. When a merged/closed PR event lands, the Worker condenses that single PR's own body text into a short summary and stores it. Issues are never summarized, neither assigned nor closed; to-do renders from issue metadata straight through. The summary is generated at capture time, stored, regenerable, and never the source of truth; the raw event body remains the truth, and render reads the stored summary. Bound it hard: the Worker may summarize one completed PR's own body, it may not summarize issues, synthesize across items, make decisions, write docs, or gate. Cross-cutting synthesis stays the agent's job.

4. Roadmap is two layers. The plan (narrative, milestones, timeline) is admin-authored via local skills and written direct and non-destructively versioned. Progress (closed/total per milestone) is event-derived, written as absolute values, with a scheduled recompute as the backstop. Milestone "done" is admin-set inside the plan write, never event-inferred.

5. Plan storage is a structured `milestones` table (keep `id`, `title`, `target_date`, `created_by`, `status`, `github_ref`; add `description`/narrative and phase), plus a `plan_versions` snapshot table for non-destructive history, plus FTS indexing so `query` stops being roadmap-blind. Do not fold the plan into `docs`/`doc_versions`; milestones must stay individually addressable so events can attribute progress to them.

6. Event capture. A GitHub webhook is a third auth class: a new top-level branch in `index.ts` before `app.fetch`, mirroring the `/mcp` branch, verifying `X-Hub-Signature-256` HMAC over the raw body against a new secret (not `COOKIE_SECRET`). HMAC is verified in the webhook branch before the gate; the gate stays signature-agnostic.

7. Two identities. The writer is `principal.login` (the webhook owner). The subject is a new `subject_login`, trusted only after signature verification, carried on a new `ingestEvent` arm. The `consumer.ts:278` rule (author = principal, client ignored) applies to the writer identity only and must not clobber the subject.

8. Dedup. A new events table with a UNIQUE constraint on a derived semantic key (`gh:pr:42:merged`, `gh:commit:<sha>`), written INSERT OR IGNORE. Not the delivery GUID (manual redelivery gets a fresh one). Leave `processed_items` alone; it is for batch replay. Absolute-value progress writes make event ordering irrelevant by construction.

9. Identity map. Promote `people.ts` into a D1 table, seeded from the current object, admin-maintained. An event whose subject is unmapped is captured with its raw login and simply does not surface in anyone's My Work until mapped. Captured, never dropped.

10. Token. Retire the per-user `github_token` render use. The scheduled recompute still reads GitHub, on a schedule, with an app-level service token, off the render path. "No GitHub at render" holds.

## Phase 0: build the spine (no teardown)

Create the new D1 stores and migrations, and register them in `test/apply-migrations.ts`:

- Captured-event store: raw event body, `subject_login`, type, provenance, semantic key (UNIQUE). This is the log My Work and the progress recompute read from.
- Completed-PR summary: the Worker-generated summary attached to (or keyed to) the merged/closed PR event. Implementer picks the shape; it is a derived projection, regenerable from the raw PR body, not truth. Issue events never enter this store.
- Per-milestone progress cache: absolute closed/total plus a source timestamp.
- Identity map table: `login` to Canopy person, admin-maintained.
- Plan store: the altered `milestones` table plus `plan_versions`.

Then wire the pipeline:

- Add a `CapturedEvent` schema to the contract and an `events[]` arm to `IngestPayload`. Add `ingestEvent(...)` and a loop in `consume()`. Reuse the same gate, do not add a second write path.
- Add the webhook branch in `index.ts` (HMAC-verified, subject trusted post-verify, calls `ingestEvent`).
- Add the completed-PR summarization step in the Worker (Workers AI binding or the Anthropic API, implementer's call), fired only on merged/closed PR events. Generate on capture, store, never at render. Issue events skip it.
- Add the `scheduled()` recompute handler and its `[triggers]` in `wrangler.toml`, using the service token. This is a computed direct writer, in the same non-gated class as `promote`; that is consistent with decision 1.
- Add a bearer MCP read tool `get_my_work` that returns the calling principal's My Work projection from D1 as two separate lists: previous-activity (summarized PRs, last 14 days) and to-do (open assigned issues). None exists today.

Run the webhook against a replayed sample delivery and a backfill so the stores are populated before any render flips.

## Phase 1: stop the inflow (breaks no live reader)

- Alter the `record-session` skill: keep feed entries, doc proposals, ADR drafts, read-before-write, the single gated call. Drop the milestone block and the focus block from what it emits.
- Alter the `canopy` umbrella skill: rewrite the read/write maps to the plan model, drop focus and `propose_milestone`, reconcile `get_roadmap`.
- Retire the MCP tools `set_focus` and `propose_milestone` (plan layer). Keep the `ingestMilestoneProposal` and `ingestFocusUpdate` gate functions for now; triage-assign and existing tests still call the milestone one. Narrow the `record_session`/`IngestPayload` contract to drop the `milestone_proposals` and `focus` arms of the accepted payload (a real contract change, not docs-only), but retain the gate fn.

## Phase 3: flip render surfaces to D1 (after Phase 0 data is live)

- Rewrite `GET /roadmap`, MCP `get_roadmap`, and `GET /me/dashboard` to read only the new D1 stores (plan table, progress cache, events store, identity map, summaries). The dashboard returns the two separate lists, previous-activity (summarized PRs, last 14 days) and to-do (open assigned issues), not one merged feed. Keep the degraded-payload shape so it still never 500s.
- Only then delete the four live-GitHub fetch sites (`roadmap.ts:35/49`, `dashboard.ts:145/183`) and the `getStoredToken` calls at `routes.ts:182/192`, `mcp.ts:118`.
- Index the plan and progress into FTS so `query` surfaces the roadmap.

## Phase 4: final focus and token drop (after the dashboard no longer reads focus)

- Drop `get_focus` (`reads.ts:120`), the dashboard focus branch, the focus render block (`render.ts:1367-1390`), the `focus` table (migration 0007), `FocusRow`, the contract `Focus` field, the focus arm of `consume`, and the focus/dashboard tests that no longer apply.
- Resolve `users.github_token`: drop the per-user render use; if the recompute uses an app-level service token, the per-user column can go.

## Skills

- `record-session`: ALTER as in Phase 1.
- `canopy`: ALTER as in Phase 1.
- `read-plan`: NEW, local admin skill. Returns the current plan (narrative, milestones, timeline) plus the relevant captured events so the admin shapes against reality. Partial reuse of the milestones read; narrative and events reads are new.
- `update-plan`: NEW, local admin skill. Pushes the reshaped plan back through the direct, non-destructively versioned plan-write path (a bearer MCP tool, same class as `promote`). Sets milestone status including done. This is the plan write surface referenced in decision 4.
- `my-work`: NEW, standalone. Wraps the new `get_my_work` MCP read tool so a person can pull their own My Work context on demand. Also invoked by the session-start skill (`load-context`) so orientation auto-includes it. Keep it thin: it reads the projection, it does not write.

## Frontend and styling

Follow the current styling. Reuse the existing view functions, design tokens, and component patterns in `render.ts` and the established Canopy design; do not introduce a new visual language. The rebuilt My Work and Roadmap screens should look like they always belonged.

Render markdown nicely. The Worker-generated completed-PR summaries (previous activity) and the roadmap narrative are markdown, and must render as cleanly styled HTML consistent with the current design, not as raw text. Use or add a lightweight markdown renderer wired into the existing style, applied to those surfaces. To-do renders from issue metadata and needs no markdown.

## Invariants that must hold

- No live GitHub at render, and no live generation at render. Capture once, summarize at capture, read local.
- Ingested content is gated through `consume()`; authored (plan) and computed (progress, summary) writes are direct, in the `promote` class.
- GitHub is where assignment and activity happen. Canopy captures them, never assigns in parallel.
- Every captured event carries its subject person (or its raw login if unmapped), or My Work cannot filter.
- Milestone done is admin-set in the plan write, never event-inferred.
- The bearer-vs-cookie surfaces stay separate; the webhook is the third, signature class, and never touches `sessionGate`.
- Plan writes are versioned non-destructively even though they are direct.

## Out of scope / deferred

- Phase 2: retiring `milestone_proposals`, `GET /milestone-proposals`, promote/reject routes, the Triage milestones queue, and reworking triage-assign. Rides with the triage pass.
- Feed and Docs internals, except where they share a table this build touches.

## Build order

Phase 0, then 1, then 3, then 4. Each step testable in isolation, each teardown gated on its replacement being live. Never remove `POST /ingest`, `consume()`, `append_feed`, or the `milestones` table (ALTER only); they stay live consumers throughout.
