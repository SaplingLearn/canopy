---
name: record-session
description: Use when a person explicitly asks to wrap up, record, log, or capture the current Claude Code session into Canopy (triggers — "record this session", "session-end", "log this to Canopy", "save what we did"). Explicit invocation only — must never auto-fire at a natural stopping point.
disable-model-invocation: true
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), mcp__canopy__append_feed, mcp__canopy__get_feed, mcp__canopy__propose_doc_update
---

# Record Session → Canopy

## Overview

At the **end** of a session, when a person asks for it, this skill observes what the session
actually shipped (from git/gh), shapes it into a Canopy **feed_entry**, and writes it through the
`append_feed` MCP tool on the `canopy` server. It is the **producer** half of Canopy's contract; a
server-side **gate** decides write-vs-triage. You build the mouth — you do not bypass the gate.

**Core principle: observe, never recall.** Every artifact (commit, PR, issue) is copied from real
`git`/`gh` output, not from your memory of the conversation. The prose body may summarize intent;
the artifacts must be observed. This mirrors how Canopy reads roadmap progress live from GitHub
rather than storing it.

## When to use

- A person **explicitly** says: record / log / wrap up / capture this session.
- **One** entry per explicit request.

## When NOT to use

- **Never auto-fire.** A natural endpoint (tests pass, branch done) is not a trigger. A four-person
  team starting out needs a writer it trusts; an auto-firing one floods the feed and erodes trust.
- Never to **promote, ratify, or complete** anything — those are human-only HTTP routes, not MCP
  tools, and not yours.

## Procedure

### 1. Gather (observe from git/gh)

| Need | Command (copy values verbatim from output) |
|------|--------------------------------------------|
| Branch | `git branch --show-current` |
| Session commits | `git log "$(git merge-base HEAD <default-branch>)"..HEAD --format='%H %s'` (the commits this branch adds over the default branch). If you are *on* the default branch, scope another way — e.g. `git log --since=<when-session-started>` — and include only shas the command actually prints. |
| PR | `gh pr view --json number,url` (current branch) or `gh pr list --head <branch> --json number` |
| Issues | issue numbers referenced by those commits/PR, confirmed with `gh issue view <n>` or read from the real commit/PR text |

If `gh` is unavailable, or a fact is not in `git`/`gh`, it does **not** go in artifacts. No exceptions.

### 2. Shape (fit the contract — a `feed_entry`)

- `summary` — one tight line.
- `body` — factual builder prose: what changed and why. No secrets, tokens, or your bearer.
- `tags` — **only** from the controlled vocab (see Vocabulary). Tags express *placement*, not importance.
- `artifacts` — `{ prs: string[], commits: string[], issues: number[] }`, all observed in step 1.
  (Per the contract, prs/commits are strings, issues are numbers.)
- **Do NOT set author.** The server resolves the author from your bearer; any author you send is ignored.

### 3. Confidence decides the path (placement certainty, not importance)

```
in-vocab tag truly fits + factual event + observed artifacts ──► HIGH ──► append_feed → lands in the feed
otherwise (no fitting tag / guessing / recording an interpretation) ──► LOW ──► gate routes to needs_triage
```

- **HIGH:** call `append_feed` with the fitting in-vocab tag(s). The gate writes it straight to the feed.
- **LOW:** do **not** substitute an unrelated in-vocab tag to force a clean write — that fakes placement.
  Call `append_feed` with the descriptive tag you actually reached for (it will be out-of-vocab); the
  gate routes the **whole entry** to `needs_triage` for a human to place. **Routing to triage is the
  correct, designed outcome for an uncertain entry — not a failure.** When unsure, set it low.

### 4. Write surface — reach for, in order

- **DEFAULT — `append_feed`.** Almost everything a session produces is a feed entry.
- **OCCASIONAL — `propose_doc_update`.** Only when the session durably changed a convention or
  architecture note that belongs in a doc. It **stages** a proposal (`section` from vocab,
  `confidence`); out-of-vocab section or `confidence:"low"` routes to triage. You stage; you never promote.
- **ESSENTIALLY NEVER — `propose_milestone`.** A session wrap-up does not create roadmap milestones.
  Only on an explicit, separate ask.

## Vocabulary — source of truth is `shared/vocabulary.ts` (verify before tagging)

- **Feed tags:** `auth`, `architecture`, `infra`, `api`, `ui`, `data`.
- **Doc sections** (`propose_doc_update` only): `reference`, `context`, `decisions`.
- A feed entry has **no section** — tags alone place it. No tag fits → that's the LOW signal (step 3),
  not license to coin a tag.

## Hard rules (invariants)

- Never set or spoof **author** — the authenticated principal owns it.
- Never mark `'done'`, never **promote / ratify / complete**. You only stage or append; humans confirm.
- Never **invent vocab**. In-vocab, or out-of-vocab → triage. Nothing in between (no fudging a borderline tag).
- Never write **secrets, tokens, or the bearer** into a body or artifact.
- **Artifacts are observed** from git/gh, never recalled.

## Example

`git log` shows one commit; `gh pr view` shows PR 14:

```
$ git log main..HEAD --format='%H %s'
abc123def... feat(mcp): widen append_feed to carry prs/commits
$ gh pr view --json number → { "number": 14 }
```

→ HIGH (the `api` tag fits the MCP write surface), so call `append_feed`:

```json
{
  "summary": "Widen append_feed to record prs/commits",
  "body": "append_feed dropped prs/commits; widened the MCP tool to pass both through the same gate (no new write surface). Added a round-trip test; suite green.",
  "tags": ["api"],
  "issues": [],
  "prs": ["14"],
  "commits": ["abc123def..."]
}
```

If instead the work were a test-harness refactor with no fitting tag, you would call `append_feed`
with the tag you wanted (e.g. `"testing"` — out of vocab) and let the gate route it to `needs_triage`.

## Common mistakes

- Listing a commit/PR/issue from memory that `git`/`gh` does not show → fabricated artifact.
- Forcing an in-vocab tag onto work it doesn't describe → should have been low/triage.
- Setting `author`, marking `done`, or promoting/ratifying → not yours; humans confirm.
- Auto-firing at a natural stopping point instead of waiting for an explicit ask.

## Install (one-time, per teammate)

The skill ships in the repo at `.claude/skills/record-session/` and is **auto-discovered** — no setup.
To let your session reach Canopy's MCP tools, configure the `canopy` MCP server with your **personal**
bearer (never committed). See the repo README, "Canopy MCP setup": a `.mcp.json` `streamable-http`
entry to the Canopy origin with `Authorization: Bearer ${CANOPY_MCP_TOKEN}`, and
`export CANOPY_MCP_TOKEN=...` in your shell.
