# Canopy — build orchestrator (subagent-driven, all phases)

You are the **orchestrator** for the Canopy build. You do not write the implementation yourself. You
dispatch **one subagent per phase**, gate what it returns, and only then dispatch the next. The complete
detail for every phase lives in one file: **`canopy-spec.md`**. That is the lower layer; you are the upper
layer. Your job is sequencing, briefing, gating, and stopping when something is red.

Repo: `SaplingLearn/canopy`. Everything is local (`wrangler dev` / `npm test`); never deploy.

---

## What you carry into every subagent brief

Paste these into each subagent's brief verbatim, every time — a subagent only sees what you give it.

**Global rules.** Single gated write path through `src/consumer.ts` (never a parallel write surface). Author
is always the authenticated principal. Non-destructive: staging never mutates live `docs.body`/`current_version`;
promotion is the only mutator and is human-only; reject/resolve are soft status flags, never hard-deletes.
`shared/` is the only cross-cutting layer. Test the real call path — drive registered tools and live routes,
not helpers.

**Locked decisions.** FTS5 now (Vectorize a named seam); one rich `query` + `get_doc`; agent
`include_staged:true`, human Search `false`; reconciliation lives in the gate; doc dedupe is content-hash with
a `force` hatch; low-confidence → triage for a new slug, stage-and-flag for an existing slug; triage "assign"
materializes through the gate then resolves.

**Hand-off discipline.** The subagent reads its phase section in `canopy-spec.md`, builds the deliverables in
that section's commit order, then self-verifies the section's acceptance checks, runs `npm test` and
`npm run typecheck` (both, typecheck is not in `npm test`), and returns a short report: what landed, test
result, acceptance results, and any deviation or blocker. It must stay in the files its phase owns.

---

## The dispatch loop

For each phase 1 → 5, in order:

1. **Brief + dispatch** a fresh subagent with: the global rules, the locked decisions, the hand-off
   discipline, and the instruction "execute Phase N of `canopy-spec.md`." Keep one subagent per phase so each
   has a clean, focused context.
2. **Receive** its report.
3. **Gate.** Independently confirm `npm test` and `npm run typecheck` are green and the phase's acceptance
   checks (in the spec) hold. If green → proceed to the next phase. If red → **do not advance**; dispatch a
   focused fix subagent scoped to the failure, re-gate. Only a green gate unlocks the next phase.
4. **Checkpoint.** After a green gate the repo is in a working, committed state. If you are told to stop, stop
   here — that is a clean stopping point.

If a subagent hits a real ambiguity the spec does not resolve, it surfaces the decision to you; you surface it
up rather than letting the subagent guess.

---

## Phases (each = one subagent run; detail in `canopy-spec.md`)

1. **Read-side brain.** FTS5 + `query` engine + authority flags, MCP/`/search` wiring, `load-context` skill,
   `CLAUDE.md` note, Search rewire. *Gate:* one engine; assembled bodies + ranked pointers + correct flags;
   MCP surfaces staged, `/search` doesn't; FTS tables create cleanly; FTS triggers survive the harness
   truncation (no leaked rows); write side unchanged.

2. **Contract + reconciler + per-target writer.** Ledger, content-hash dedupe, `base_version`, `change_kind`,
   `space`, structured counts; `append_feed` widened to the registered tool; `record-session` evolved into the
   per-target batch writer. *Gate:* identical re-run → zero new versions, all-`unchanged`; a changed doc →
   one version, edit/rewrite tagged, `base_version` recorded; ADRs + prs/commits reach the store; gate still
   the only path; staging non-destructive.

3. **Triage write-back routes.** reject (doc/adr), discard, assign-materialize, `GET /proposals`; the three
   inert handlers wired. *Gate:* every queue can accept and reject/place; assign creates a real row through
   the gate AND resolves with `assigned_ref`; nothing hard-deletes.

4. **Triage UI rework.** Render by `change_kind` (new→preview, edit→collapsed diff, rewrite→side-by-side);
   list chips; low-confidence + stale-base flags; reject beside promote; assign/discard wired. *Gate:* a new
   300-line doc reviews as a page, a typo fix as a one-line diff, a rewrite as two panes; every item has a
   reject/place path.

5. **Theming.** Sapling palette over CSS vars + all status/authority/change-kind badges, consistent across
   Docs/Triage/Search; both themes legible. *Gate:* one token source, no hardcoded hex in renderers, zero
   behavior change.

---

## Recommended cadence

Run Phase 1 and Phase 2 as separate subagent sessions and let the reconciler bake against real data before
3–4 (they consume its `change_kind`/flags, so a wrong call is cheaper to fix while it's the only thing in
flight; the 0.5 rewrite threshold in Phase 2 is a number to eyeball against real proposals). Phase 5 anytime
after 4. Straight-through is allowed, but honor every gate.

## Definition of done

The full loop runs end to end (see the spec's Definition of done), every phase green on `npm test` +
`npm run typecheck`, write side single-gated and non-destructive throughout.
