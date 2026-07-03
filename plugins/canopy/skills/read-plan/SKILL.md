---
name: read-plan
description: Use when an admin wants to read the current roadmap plan and check it against what actually happened (triggers — "read the plan", "what's the roadmap state", "show me the plan against reality", "where does the roadmap stand"). Read-only — this skill never writes.
allowed-tools: mcp__canopy__get_roadmap, mcp__canopy__get_events, mcp__canopy__query
---

# Read Plan ← Canopy

## Overview

Reads the roadmap plan — the admin-authored narrative plus milestones, each carrying cached,
event-derived progress — and pairs it with the recent captured activity that progress is built from.
The point is to give an admin a true read of where the plan stands **and** what has actually shipped
recently, so they can spot drift before deciding whether to reshape the plan (the `update-plan` skill).
This skill is read-only; it never proposes or writes anything.

Part of the **`canopy`** skill set. `update-plan` is the write counterpart — always read here (or via
its own `get_roadmap` call) before writing.

## When to use

- An admin asks to see the roadmap plan, its milestones, or its progress.
- An admin wants to check the plan against reality before deciding whether to update it.
- Preparing to run `update-plan` — reading first is how you know what's current.

## When NOT to use

- To write or change the plan — that's `update-plan`, and it's explicit-only.
- For a person's own work items — that's `my-work` (`get_my_work`), not the roadmap.

## Procedure

1. **`mcp__canopy__get_roadmap`** — read the plan: `{narrative, version, updated_at, updated_by,
   milestones:[{id, title, description, phase, target_date, status, github_ref, progress}]}`. Each
   milestone's `progress` (`{closed, total, computed_at}` or `null`) is **cached**, not live GitHub —
   note `computed_at` when reporting it.
2. **`mcp__canopy__get_events`** — pull recent captured activity (e.g. `limit: 30`) so you can compare
   the plan against what has actually happened: merged/closed PRs and issues that plausibly belong to a
   milestone but aren't reflected in its `status` or `progress` yet. Filter by `type` or `subject` when
   you're checking one specific milestone.
3. **Optionally `mcp__canopy__query`** for related doc/decision context (e.g. why a milestone's scope
   changed) when the narrative references something you need more background on.
4. **Report, don't guess.** Summarize the plan (narrative + milestones + progress) alongside anything
   from `get_events` that looks like drift — a milestone whose linked issues are closing out but whose
   `status` is still `upcoming`/`in_progress`, or recent activity that doesn't map to any milestone.
   Flag it for the admin; don't silently reconcile it yourself.

## Hard rules

- **Read-only.** Never call `update_plan` or any write tool from this skill.
- **Progress is cached, not live.** Always note it came from `computed_at`, not a fresh GitHub read.
- Present drift as an observation for the admin to act on (via `update-plan`), never as an
  already-made decision.
