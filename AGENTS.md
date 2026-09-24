# AGENTS.md

A short guide for coding agents working in or against **Canopy**, the team's shared context store. The
full developer notes for this repository are in `CLAUDE.md`.

## Connect

Canopy speaks MCP at `<origin>/mcp` with a personal bearer token (web app → Settings → *Get connection
command*). Every write you make is recorded as the person who owns the token.

## Use the canopy skill

The skills in `plugins/canopy/skills/` (symlinked from `.claude/skills/`) are how Canopy stays living:
`canopy` is the map — start there — `load-context` orients before you touch an existing area, and
`record-session` records what a session shipped, only when a person asks. The `query` parameter
reference is `plugins/canopy/skills/canopy/references/querying.md`.

## The rules that matter

- **Knowledge is staged, a person confirms.** Doc changes, ADRs and feed entries go through the gate
  (`propose_doc_update`, `append_feed`, `record_session`); promoting and ratifying are web-only.
- **Authored work is direct, and scoped.** Tickets: only ones already assigned to you (filing is the
  exception). Sprints and the plan: admin only.
- **Trust `live`.** Anything flagged `staged_pending`, `unpromoted` or `draft` is not settled yet.

## Artifacts

Versioned pages — HTML, markdown, SVG, mermaid, images, PDFs, files — that you create and update with
`artifact_create` / `artifact_update` and read with `artifact_get`. Binary files go through a
single-use, five-minute upload URL. **Ratifying an artifact is a person's act on the web; no tool does
it.** Kinds, caps, statuses, permissions and the upload flow: **`docs/artifact-contract.md`**.
