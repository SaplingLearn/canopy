---
name: update-plan
description: Use when an admin explicitly asks to update, rewrite, or change the roadmap plan — narrative or milestones, including marking a milestone done (triggers — "update the plan", "rewrite the roadmap narrative", "add a milestone", "mark this milestone done"). Explicit invocation only — must never auto-fire.
disable-model-invocation: true
allowed-tools: mcp__canopy__get_roadmap, mcp__canopy__update_plan
---

# Update Plan → Canopy

## Overview

Writes the roadmap plan — narrative and milestones — through the **direct, admin-authored**
`update_plan` MCP tool. This is a **promote-class** write, not the ingestion gate: there is no
staging/triage step and no confirmation queue. It IS still non-destructive — every call bumps the
plan version and snapshots the prior state (`plan_versions`), so nothing is lost — but it takes
effect immediately. That's why this skill is **explicit-only**: it must never auto-fire, the same as
`record-session`.

Part of the **`canopy`** skill set. `read-plan` is the read counterpart — always read first (this
skill does so itself, in step 1) so you never write blind.

## When to use / NOT use

- Use only when an admin **explicitly** asks to change the plan: rewrite the narrative, add/edit a
  milestone, or mark one done.
- **Never auto-fire.** Reading the plan, discussing it, or noticing drift is not license to write it —
  that's `read-plan`'s job. Only an explicit ask reaches this skill.
- Never infer `status: 'done'` from issue/PR activity — `done` is only ever admin-said-so, here or via
  the web Confirm-done button. Nothing else agent- or worker-reachable can set it.

## Procedure

### 1. Always `get_roadmap` first (read-before-write)

Call `mcp__canopy__get_roadmap` before composing anything. Carry forward:
- The current `narrative` (you'll pass a full replacement, so start from what's live).
- Every existing milestone's **`id`** — pass `id` on a milestone you're editing so the tool updates it
  in place; a milestone omitted from your call is **untouched**, not deleted. Omitting `id` on a new
  entry creates it.

### 2. Show the admin a diff and get confirmation

Before writing, lay out plainly what will change: narrative before/after (or "narrative unchanged"),
and per milestone — created / edited (with the specific fields changing) / left untouched. Get the
admin's explicit go-ahead on that diff before calling the write tool. If they want changes, revise the
diff and re-confirm — don't call `update_plan` speculatively.

### 3. One `update_plan` call

Once confirmed, make **exactly one** call:

```jsonc
{
  "narrative": "<full narrative text>",
  "milestones": [
    { "id": 3, "title": "...", "description": "...", "phase": "...", "target_date": "2026-09-01",
      "status": "in_progress", "github_ref": 42 },
    { "title": "<new milestone, no id>", "target_date": "2026-10-15", "status": "upcoming" }
  ]
}
```

- `id` present → update that milestone; `id` absent → create one.
- Milestones you don't list are left exactly as they are — you don't need to round-trip every
  milestone, only the ones changing.
- `status: 'done'` is legal here (this is the one agent-reachable path allowed to set it) — only set
  it when the admin explicitly confirmed the milestone is done, never inferred from closed issues.
- Report back the new plan `version` the tool returns.

## Hard rules (invariants)

- **Explicit only.** Never fire without a direct admin ask.
- **Read before write, every time** — step 1 is not optional, even for a small edit.
- **Confirm the diff before writing** — no silent writes.
- **`done` is admin-said-so only** — set here or via the web Confirm-done button, never inferred from
  GitHub activity, issue closure percentage, or `get_events`.
- **One call.** Compose the full milestones array (with unchanged ones simply omitted) and call
  `update_plan` once — this is a direct write, not a reconciling batch, so there's no replay safety net
  if you call it twice with different content.
- This is **not** the ingestion gate — no staging, no triage, no `record_session`. Don't route plan
  writes through those tools.

## Common mistakes

- Forgetting a milestone's `id` when editing it → the tool creates a duplicate instead of updating.
- Setting `status: 'done'` because issues look closed, without the admin having said so.
- Skipping the diff/confirmation step and writing straight from the ask.
- Calling `get_roadmap` after deciding what to write instead of before — you lose the current `id`s
  and the real current narrative to diff against.
