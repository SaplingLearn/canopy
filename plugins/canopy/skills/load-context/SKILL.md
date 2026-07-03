---
name: load-context
description: Orient against Canopy (the team's working memory) BEFORE working an existing area. Fire when you start work on a named/existing subsystem, pick up an issue that references an area, or when the person says things like "the X system", "how we do Y", "our approach to Z", "where is the … code/doc" — and ALWAYS before proposing a doc change. Do NOT fire on trivial one-off questions, on a brand-new area with no prior context, or just to chat. Read-only — this skill never writes.
allowed-tools: mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__get_my_work
---

# Load Context ← Canopy

## Overview

Before touching an area the team has worked before, pull the relevant context from Canopy so you
build on what already exists instead of guessing. Canopy assembles the **whole authoritative body**
of the top hits plus ranked **pointers** to the rest, and flags every result with its **authority**.
This is the **reader** half of the loop; `record-session` is the writer. This skill never writes —
it only retrieves and reports what it found.

Part of the **`canopy`** skill set — see the `canopy` skill for the whole orient→work→record loop, and
its `references/querying.md` for the full `query` parameter set (filtering by `space`, browse mode,
`pointer_limit`, `include_staged`) when a focused orient query isn't enough.

## When to use

- You're starting work on a **named or existing** subsystem (auth, the gate, the roadmap reader, …).
- You picked up an issue that references an existing area.
- The person references "**the X system**", "how we do Y", "our approach to Z", or asks where
  something lives.
- **ALWAYS before `propose_doc_update`** — read the current doc first so your change has a real base.

## When NOT to use

- Trivial one-off questions answerable without team context.
- A genuinely **brand-new** area with no prior Canopy context to load.
- As a write path — it is not one.

## Procedure

1. **Query focused.** Call `mcp__canopy__query` with a tight `q` (the subsystem / concept), narrowing
   with `types` (`doc` / `decision` / `feed`) and `section` when you can. Keep it specific — a focused
   query returns better-assembled bodies than a broad one.
2. **Read the `primary` bodies.** These are full authoritative bodies, not snippets. Skim `pointers`
   for anything worth opening; fetch the exact doc with `mcp__canopy__get_doc <slug>` when you need
   all versions.
3. **Respect the authority flag on every result:**
   - `live` — settled. Trust it.
   - `staged_pending` — a newer version is staged but unpromoted; the `body` you see is still the live
     one. Do **not** treat the pending change as settled.
   - `unpromoted` — never promoted; exists only as staged content. Treat as a draft, not as truth.
   - `draft` — an unratified decision. Not settled.
   Never present `staged_pending` / `unpromoted` / `draft` content as established fact.
4. **If you're about to write a doc,** note the doc's `current_version` from the query/`get_doc`
   result — that's the **base** the `record-session` writer should declare for its proposal.
5. **At session start, also call `mcp__canopy__get_my_work`** (no args) so orientation includes the
   person's own open work — recent shipped activity and their to-do — alongside the area context from
   steps 1–3. This is still read-only: report it, don't act on it unprompted.

## Hard rules

- **Read-only.** This skill never proposes, stages, promotes, or ratifies anything.
- **Authority is load-bearing.** Anything not `live` is not-yet-settled — flag that when you rely on it.
- Orient first, then work. The point is to build on the team's memory, not to re-derive it.
