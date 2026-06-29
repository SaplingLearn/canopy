---
name: record-session
description: Use when a person explicitly asks to wrap up, record, log, or capture the current Claude Code session into Canopy (triggers — "record this session", "session-end", "log this to Canopy", "save what we did"). Explicit invocation only — must never auto-fire at a natural stopping point.
disable-model-invocation: true
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), Bash(uuidgen:*), mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__record_session
---

# Record Session → Canopy

## Overview

At the **end** of a session, when a person asks for it, this skill observes what the session
actually shipped, **reconciles it against what Canopy already knows**, and emits ONE structured,
per-target payload that declares exactly what was touched and from what base. The worker is the
**gate**: it drops no-ops, stages only real deltas, classifies each doc change, and is replay-safe.
You build the payload; you never bypass the gate and you never confirm (promote/ratify/complete).

**Core principle: observe and reconcile, never recall.** Every artifact (commit, PR, issue) is
copied from real `git`/`gh` output. Every doc/ADR you touch is first **read back from Canopy** so
you write a true delta from a known base — not from memory of the conversation.

Part of the **`canopy`** skill set — this is the **writer** half of the loop; the `canopy` skill is the
umbrella, and `load-context` is the reader that orients before work.

## When to use / NOT use

- Use only when a person **explicitly** says: record / log / wrap up / capture this session. **One**
  payload per explicit request.
- **Never auto-fire.** A natural endpoint (tests pass, branch done) is not a trigger — an auto-firing
  writer floods the store and erodes trust.
- Never **promote, ratify, or complete** anything — those are human-only HTTP routes, not yours.

## Procedure

### 1. Inventory + classify

Observe what shipped and sort it into target types. Classify placement with the controlled vocab
(see Vocabulary); if nothing fits, that is the LOW-confidence signal (step 3), not license to coin a tag.

| Need | Command (copy values verbatim) |
|------|--------------------------------|
| Branch | `git branch --show-current` |
| Session commits | `git log "$(git merge-base HEAD <default-branch>)"..HEAD --format='%H %s'` |
| PR | `gh pr view --json number,url` or `gh pr list --head <branch> --json number,url` |
| Issues | numbers referenced by those commits/PR, confirmed via `gh issue view <n>` |

If `gh` is unavailable, or a fact is not in `git`/`gh`, it does **not** go in artifacts. No exceptions.

### 2. Read-before-write (every doc and ADR)

Before composing ANY `doc_proposal` or `adr_draft`, orient with the read tools so you write a delta,
not a blind overwrite:

- `mcp__canopy__query` to find the area's current authoritative context (respect the authority flags —
  never treat `staged_pending`/`draft`/`unpromoted` as settled).
- `mcp__canopy__get_doc` for the exact slug you intend to touch. **Capture its `current_version`** and
  pass it as the doc's **`base_version`** — that records the version your edit was based on, so the
  gate can flag a stale edit. If the doc doesn't exist, it's a new slug (omit `base_version`).
- Ground **confidence** honestly against what you read. Reconfirming a settled convention is HIGH; a
  speculative or hard-to-place change is LOW.

### 3. Confidence decides the path (placement certainty, not importance)

- **HIGH** — an in-vocab placement truly fits and the change is grounded. The gate stages/appends it.
- **LOW** — no fitting placement, or you're guessing. Set it low and let the gate route it to
  `needs_triage` for a human to place. **Routing to triage is the correct outcome for an uncertain
  entry, not a failure.** Do not force an unrelated in-vocab tag/section to fake a clean write.

### 4. One feeder block per type (emit the contract object)

Build at most one of each, only for what the session genuinely touched:

- **Feed** — one entry **per shipped unit** of work. `{ summary, body, tags[], artifacts:{ prs[],
  commits[], issues[] } }`. Artifacts are the observed git/gh values from step 1. This is the default;
  almost everything is a feed entry.
- **Doc** — only when the session durably changed a convention/architecture note that belongs in a doc.
  `{ slug, section, space, title?, body, change_summary, confidence, base_version }` (`base_version`
  from step 2; `space` is `sapling` for product docs, `canopy` for tooling docs).
- **ADR** — when the session settled a real decision. `{ title, context, decision, rationale,
  confidence }`. (Previously nothing emitted these — now they land typed in the decisions queue.)
- **Milestone** — **only if genuinely new** roadmap work. A wrap-up rarely creates one.
- **Focus** — your forward headline for the personal dashboard. `{ working_on, next_up? }`. Intent
  prose is fine here (it is exempt from the observed-artifacts rule; the feed's artifacts are not).

### 5. Assemble ONE payload and call `record_session` once

Mint a session id (`uuidgen`) — it is the **replay key**: re-running the same payload stages
nothing new. Assemble a single `IngestPayload` and pass it to the **`record_session` MCP tool** in
**one** call:

```jsonc
{
  "session": { "id": "<uuid>", "author": "ignored", "ended_at": "<ISO8601>", "skill_version": "2.0" },
  "feed_entries":        [ /* step 4 */ ],
  "doc_proposals":       [ /* step 4, with base_version */ ],
  "adr_drafts":          [ /* step 4 */ ],
  "milestone_proposals": [ /* step 4, only if new */ ],
  "focus":               { "working_on": "…", "next_up": "…" }
}
```

Call `mcp__canopy__record_session` with that payload. The MCP channel carries your bearer, so the
call authenticates as you and routes through the SAME gate as the human `/ingest` path;
**`session.author` is advisory and ignored — the server stamps the author from your authenticated
principal.** Then **report the structured counts** the tool returns, e.g.
`{ "docs": { "staged": 1, "unchanged": 2, "triaged": 0 }, … }` → "3 docs: 1 staged, 2 unchanged."
`unchanged` means the gate recognised a no-op or a replay and correctly dropped it.

## Vocabulary — source of truth is `shared/vocabulary.ts` (verify before tagging)

- **Feed tags:** `auth`, `architecture`, `infra`, `api`, `ui`, `data`.
- **Doc sections** (`doc_proposals` only): `reference`, `context`, `decisions`.
- A feed entry has **no section** — tags alone place it. No tag fits → that's the LOW signal, not
  license to coin a tag.

## Hard rules (invariants)

- Never set or spoof **author** — the authenticated principal owns it, server-side.
- Never mark `'done'`, never **promote / ratify / complete**. You only stage/append; humans confirm.
- Never **invent vocab**. In-vocab, or out-of-vocab → triage. Nothing in between.
- Never write **secrets or tokens** into a doc body or artifact.
- **Artifacts are observed** from git/gh, never recalled. Docs/ADRs are **read back before written**.
- **POST once.** The session id makes a re-POST replay-safe, but emit one payload per explicit ask.

## Common mistakes

- Composing a doc body from memory instead of reading the live doc first (step 2) — you lose the base
  and risk a stale rewrite.
- Listing a commit/PR/issue `git`/`gh` does not show → fabricated artifact.
- Forcing an in-vocab tag/section onto work it doesn't describe → should have been low/triage.
- Auto-firing at a natural stopping point instead of waiting for an explicit ask.

## Install (one-time, per teammate)

The skill ships in the repo at `.claude/skills/record-session/` and is **auto-discovered**. Configure
the `canopy` MCP server with your **personal** bearer — it carries the read tools (`query`/`get_doc`)
and the session-end writer (`record_session`) over the same channel. See the repo README,
"Canopy MCP setup".
