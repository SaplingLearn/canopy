---
name: canopy
description: Overview and entry point for working with Canopy, the team's shared context store ("the team brain"). Use when someone asks how Canopy works, how to use it, how to connect an agent, what can be read or written, or wants the whole orient→work→record loop — and as the map to the load-context (orient before work) and record-session (record at the end) skills. Read-only itself; it explains the loop and points to the right tool/skill.
allowed-tools: mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__list_tickets, mcp__canopy__get_ticket, mcp__canopy__list_sprints, mcp__canopy__get_sprint, mcp__canopy__get_repo_dashboard
---

# Canopy — the team's shared context store

Canopy holds the team's docs, decisions, roadmap, a ticket queue the whole org files into, and a
running feed of what everyone — people and their coding agents — has done.

The golden rule is about **what an agent may assert on its own**: **proposed knowledge is staged and a
human confirms it.** A doc edit, an ADR, a feed entry — none of it goes live until somebody promotes
it, however many agents are writing.

**Authored work is not knowledge, and is not staged.** A ticket is somebody's request and a sprint is
the team's plan; both take effect immediately, the same as when a person clicks the button. What
bounds those is not a queue but **scope**: a ticket write needs the ticket to be assigned to you
already, and sprint writes need admin. So there are two write classes, and it is worth knowing which
one you are in:

| | Staged — a human confirms | Direct — takes effect now |
|---|---|---|
| **What** | docs, ADRs, feed entries (`propose_doc_update`, `append_feed`, `record_session`) | tickets, sprints, the roadmap plan (`update_plan`) |
| **Why** | an agent proposing knowledge can be wrong, and a wrong doc is believed | a request or a plan is an act, not a claim — and it is visibly somebody's |
| **What bounds it** | the gate: vocab, confidence, content-hash dedupe, then Triage | scope: your own lane, or admin |

Read the two sections below in that light.

This skill is the **map**. The actual work is done by two focused skills and a set of MCP tools — they
stay separate on purpose (one must auto-fire, one must never), and this skill ties them together.

## The loop

```
orient (load-context)  →   do the work   →   record (record-session)
   reads, before work                          stages, at session end
```

1. **Orient — the `load-context` skill.** Auto-fires before you work an existing area or propose a doc
   change. It pulls the relevant context (assembled bodies + ranked pointers, each authority-flagged)
   so you build on what exists instead of guessing. Read-only.
2. **Work** as normal.
3. **Record — the `record-session` skill.** Explicit only ("record this session"). At the end it
   batches what changed and stages it through the gate in one `/ingest` POST. It must never auto-fire.

> Why two skills, not one: a skill carries a single trigger setting. `load-context` **must** be
> model-invocable (auto-orient); `record-session` **must** be explicit-only (never log on its own).
> They can't share one `SKILL.md`. This `canopy` skill is the umbrella that documents both.

Alongside the loop: **`tickets`** (explicit-only) works the ticket queue and, for an admin, the
sprints; **`my-work`** reads your own plate; **`read-plan`** / **`update-plan`** read and write the
roadmap plan. Reading tickets, sprints and the roadmap needs no skill — those tools are registered for
every principal.

## Authority is load-bearing

The writer identity behind every read/write is the person's **handle** (the GitHub login, for migrated
engineers). Every read result is flagged. Treat anything that is not `live` as not-yet-settled:

- `live` — settled. Trust it.
- `staged_pending` — a newer version is staged but unpromoted; the body you see is still the live one.
- `unpromoted` — exists only as staged content, never promoted. A draft, not truth.
- `draft` — an unratified decision.

Never present `staged_pending` / `unpromoted` / `draft` content as established fact.

## Reading

- **`query`** — the rich, ranked, full-text read over five types (`doc` / `decision` / `feed` /
  `sprint` / `ticket`). Whole authoritative bodies for the top hits plus ranked pointers to the rest,
  every result authority-flagged. **See `references/querying.md` for the full parameter set and
  patterns** (filter by type/section/space, browse, fan out via pointers, `include_staged`). This is
  the tool `load-context` wraps; call it directly for ad-hoc exploration.
- **`get_doc <slug>`** — one doc with all its versions (exact fetch).
- **`get_feed`** — the activity feed (author / tags / since / limit filters).
- **`get_roadmap`** — the roadmap plan: an admin-authored narrative + **sprints** (each with `label`,
  `summary`, `phase`, `dates`, `due`, `status`/`active`, `urgency`, `lead`, `domain`) merged with their
  progress (`closed/total/pct` — the sprint's tickets PLUS its cached GitHub issue counts) and
  `members` (the handles assigned to those tickets); no live GitHub at read time.
- **`list_tickets` / `get_ticket`** — the org-wide ticket queue, read-only: `list_tickets` takes
  `seg` (`open` / `closed` / `all`), `assignee` (`anyone` / `me` / `unassigned`) and `category`;
  `get_ticket <id>` is the whole ticket (assignees, links, comments, history, parent + sub-tickets).
- **`list_sprints` / `get_sprint`** — the sprint containers, read-only: `list_sprints` is every
  sprint in roadmap order with its progress and members; `get_sprint <id>` adds the sprint's tickets
  (roots then their sub-tickets) and its merged resource links.
- **`get_my_work`** — your captured-event My Work projection: previous-activity (summarized merged/closed
  PRs from the last 14 days) + to-do (open assigned issues); built from captured GitHub events, no live
  GitHub.
- **`get_events`** — recent captured GitHub events, filterable by type/subject/limit.
- **`get_repo_dashboard`** — the Repo dashboard for the org's main repository, read from Canopy's own
  database (never live GitHub): environments and deploys, CI, code activity, usage (requests, errors,
  hosting, active users), the app's product metrics, and planning. **Use it to orient before work that
  touches deploys, CI health, usage or product metrics.** Optional `tab` (`overview` / `code` / `ci` /
  `usage` / `planning`) returns just that tab's sections, `range` (`24h` / `7d` / `30d`, default `7d`)
  picks the usage view, and `include_trends` (default off) adds the sparkline series. Every section is
  `ok`, `empty` or `not_connected` — **anything not `ok` is unknown, not zero.** Read-only: polling
  and Sync GitHub are admin actions in the web app, never MCP tools.

## Writing (agents stage, humans confirm)

Agents stage through the gate via MCP: **`append_feed`**, **`propose_doc_update`**. The gate reconciles
every write — it de-duplicates no-op proposals, tags each doc change `new` / `edit` / `rewrite`, and
routes out-of-vocab or low-confidence entries to Triage. **Confirming** (promote / ratify / reject /
assign / discard) is done by a human in the web Triage desk over session-cookie routes — **never** MCP
tools. The roadmap plan itself is **admin-authored**, not staged by agents: the `update-plan` skill
wraps the `update_plan` MCP tool (direct, non-destructively versioned, promote-class) — agents cannot
propose a sprint at all (the roadmap-proposal queue was retired), and sprint `done` is admin-set.

### Tickets and sprints — writes in your own lane

Ticket writes go **direct**, in the same promote class as the cookie routes: no gate, no staging, no
triage step — a ticket write is org-visible immediately. What bounds them is scope, not staging:

> **You may write only to tickets already assigned to you.** Filing (`create_ticket`) is the one
> unscoped write.

- **`create_ticket`** — file a ticket. The requester is you. Its `assignees` is the **only**
  agent-reachable assignment in Canopy: there is no `toggle_assignee` tool and never will be, because
  assignment is the data the lane rule is built on. After filing, assigning is web-only.
- **`transition_ticket` / `add_ticket_comment` / `add_ticket_link` / `set_ticket_sprint` /
  `set_ticket_parent`** — scoped. Outside your lane you get `{"code": "forbidden"}` and nothing is
  written. `set_ticket_parent` needs the lane on both tickets.
- **Sprint writes are ADMIN-ONLY**: `create_sprint`, `set_sprint_active`, `complete_sprint`,
  `add_sprint_resource`. A non-admin does not see them in `tools/list` at all.
- One admin exception to the lane: an admin may `set_ticket_sprint` on any ticket, because composing
  a sprint is sprint management. It spreads to no other verb.

**`done` / `declined` on a ticket, and `done` on a sprint, are still never INFERRED** — not from a PR
merging, an issue closing, the cron, or every ticket in a sprint resolving. A person asks for them,
through their own token. The **`tickets`** skill is the explicit-only wrapper for all of this.

Note there is **no provenance**: a write made through your token is recorded as *you*, with nothing
marking it agent-made. Use the `tickets` skill's `comment_prefix` config if your team wants agent
comments recognizable.

## Connect an agent over MCP

Mint a personal token first: Canopy web app → Settings → MCP access tokens (shown once).

**Recommended — install the plugin** (bundles all three skills AND auto-wires the MCP server):

```bash
claude plugin marketplace add SaplingLearn/canopy
claude plugin install canopy@canopy
export CANOPY_MCP_TOKEN=canopy_mcp_…        # the plugin's MCP config reads this
```

**Manual fallback** — wire the MCP server and copy the skills yourself:

```bash
claude mcp add --transport http canopy https://canopy.saplinglearn.com/mcp \
  --header "Authorization: Bearer canopy_mcp_…"
# then copy the skill folders into another repo / your home dir:
cp -r .claude/skills/{canopy,load-context,record-session,tickets} ~/.claude/skills/
```

The skills are bundled in this repo under `plugins/canopy/skills/` (the in-repo `.claude/skills/*`
entries are symlinks into that bundle, so there is a single source of truth).
