---
name: canopy
description: Overview and entry point for working with Canopy, the team's shared context store ("the team brain"). Use when someone asks how Canopy works, how to use it, how to connect an agent, what can be read or written, or wants the whole orient→work→record loop — and as the map to the load-context (orient before work) and record-session (record at the end) skills. Read-only itself; it explains the loop and points to the right tool/skill.
allowed-tools: mcp__canopy__query, mcp__canopy__get_doc
---

# Canopy — the team's shared context store

Canopy holds the team's docs, decisions, roadmap, and a running feed of what everyone — people and
their coding agents — has done. The golden rule: **agents only ever stage changes; a human confirms
the ones that matter.** Nothing an agent writes goes live until someone promotes it, so the store
stays trustworthy no matter how many agents write to it.

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

## Authority is load-bearing

Every read result is flagged. Treat anything that is not `live` as not-yet-settled:

- `live` — settled. Trust it.
- `staged_pending` — a newer version is staged but unpromoted; the body you see is still the live one.
- `unpromoted` — exists only as staged content, never promoted. A draft, not truth.
- `draft` — an unratified decision.

Never present `staged_pending` / `unpromoted` / `draft` content as established fact.

## Reading

- **`query`** — the rich, ranked, full-text read. Whole authoritative bodies for the top hits plus
  ranked pointers to the rest, every result authority-flagged. **See `references/querying.md` for the
  full parameter set and patterns** (filter by type/section/space, browse, fan out via pointers,
  `include_staged`). This is the tool `load-context` wraps; call it directly for ad-hoc exploration.
- **`get_doc <slug>`** — one doc with all its versions (exact fetch).
- **`get_feed`** — the activity feed (author / tags / since / limit filters).
- **`get_roadmap`** — milestones with live GitHub progress merged at read time.

## Writing (agents stage, humans confirm)

Agents stage through the gate via MCP: **`append_feed`**, **`propose_doc_update`**,
**`propose_milestone`**, **`set_focus`**. The gate reconciles every write — it de-duplicates no-op
proposals, tags each doc change `new` / `edit` / `rewrite`, and routes out-of-vocab or low-confidence
entries to Triage. **Confirming** (promote / ratify / reject / assign / discard) is done by a human in
the web Triage desk over session-cookie routes — **never** MCP tools.

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
cp -r .claude/skills/{canopy,load-context,record-session} ~/.claude/skills/
```

The skills are bundled in this repo under `plugins/canopy/skills/` (the in-repo `.claude/skills/*`
entries are symlinks into that bundle, so there is a single source of truth).
