# Agent ticket & sprint writes over MCP — implementation brief (2026-09-17)

Implements issues #45 (ticket writes over MCP) and #46 (the `tickets` Claude Code skill).

**Design source of truth: `docs/superpowers/specs/2026-09-17-agent-ticket-writes-design.md`.** Read it
first — every judgment call is in its §0 decision ledger (`D1`–`D10`), and this brief cites those IDs
rather than re-arguing them. Where this brief and the design disagree, the design wins.

Predecessor: `docs/superpowers/plans/2026-09-16-canopy-tickets.md` (the tickets build). Its §A
invariants are **narrowed, not repealed** — design §2 has the exact before/after, and Phase 5 is where
that reaches the docs.

---

## D. Global rules

1. **One rule, one place.** Assignee scope lives in `src/tools/tickets-agent.ts` and nowhere else.
   `src/mcp.ts` never calls `src/tools/tickets.ts` directly for a write, and `src/tools/tickets.ts`
   does not learn about scope.
2. **The cookie path does not change.** No signature churn in `src/tools/tickets.ts` or
   `src/tools/sprints.ts`, no edits to the ten ticket routes or the four sprint write routes in `src/routes.ts`.
   A human on the web was never assignee-scoped and still isn't. If a phase finds itself editing
   `routes.ts`, stop — that is the design going wrong.
3. **Never re-declare a shared rule.** `canTransition`, the four nesting rejections, `requirePerson`
   and `parseTicketLink` are reached through the existing writers. The MCP layer adds scope and
   nothing else.
4. **A rejection writes nothing.** Every refusal — `forbidden`, `conflict`, `bad_request`, `not_found`
   — must leave D1 byte-identical. D1 has no transaction here, so scope is asserted **before** the
   first mutation, never between two.
5. **404 before 403.** An unknown ticket id is `not_found`, never `forbidden` — the scope check must
   not become an existence oracle.
6. **No migration.** `0025_sprints.sql` stays the head. Nothing in `web/` changes (D4).
7. **Tests drive the registered closures** through `buildCanopyMcpServer` + `InMemoryTransport`, the
   way `test/mcp.tickets.test.ts` already does. Never call a writer directly to prove a tool works.
8. `npm test` **and** `npm run typecheck` are both green before a phase is called done (typecheck does
   not run inside `npm test`).
9. Handles compare `COLLATE NOCASE`, matching `persons.handle` and the existing ticket reads.

---

## Phase 1 — the scope primitive

**Deliverables**

- `src/tools/tickets.ts` (where `TicketError` lives — it is server-side, not in `shared/`): the
  code union gains `"forbidden"` and `TICKET_ERROR_STATUS` gains `forbidden: 403`. Nothing else in
  the file changes, so the cookie routes' error mapping keeps working untouched.
- **New** `src/tools/tickets-agent.ts` — the whole MCP ticket write surface:
  - `assertTicketWritable(db, env, id, handle, verb)` — loads the row (404 first), returns early for
    the D6 admin/`set_ticket_sprint` exception, then requires a `ticket_assignees` row for `handle`
    `COLLATE NOCASE`, else `TicketError("forbidden", …)`.
  - Six exported wrappers, each *assert then delegate*, signatures mirroring the writers so the
    delegation is one line: `agentTransitionTicket`, `agentAddTicketComment`, `agentAddTicketLink`,
    `agentSetTicketSprint`, `agentSetTicketParent`, and `agentCreateTicket` (which asserts **nothing**
    — the one unscoped write, D2 — and exists only so `mcp.ts` has a single import surface).
  - `agentSetTicketParent` asserts on **both** ids (design §1).
  - A file-head comment carrying the rule verbatim and citing D2/D3/D6.

**Tests** (`test/tickets.agent-scope.test.ts`, new — unit-level, writers direct; the MCP-level pass is
Phase 2)

- assignee → permitted; non-assignee → `forbidden`; unknown id → `not_found` even for a non-assignee.
- Case-variant handle (`Andres` vs `andres`) resolves to the same lane.
- Every refusal leaves the ticket row and all four child tables untouched.
- D6: admin + `set_ticket_sprint` on an unassigned ticket → permitted; admin + `transition_ticket` on
  the same ticket → `forbidden` (the exception does not spread).
- `set_ticket_parent` with the lane on only one of the two ids → `forbidden`.

---

## Phase 2 — register the ticket write tools

**Deliverables**

- `src/mcp.ts`: six `server.tool(...)` registrations for every bearer principal, named per D7 —
  `create_ticket`, `transition_ticket`, `add_ticket_comment`, `add_ticket_link`, `set_ticket_sprint`,
  `set_ticket_parent` — each a thin adapter over its Phase 1 wrapper, actor = `principal.handle`.
  Inputs reuse the `@shared/tickets` payload schemas (`TicketCreate` etc.) so the contract is not
  restated; each tool returns the full `TicketDetail`, exactly like the cookie routes do.
- **No `toggle_assignee` tool** (D3). `create_ticket` keeps `TicketCreate.assignees` — the one place
  assignment is agent-reachable.
- Tool descriptions state the lane rule plainly ("only on tickets already assigned to you; assignment
  itself is web-only") and drop every "there is no MCP write path" claim.
- The four **read** tools' descriptions lose the same stale clause (a Phase 2 edit, because a Phase 5
  test asserts on it).

**Tests** (`test/mcp.tickets.test.ts`, edited + `test/mcp.tickets.writes.test.ts`, new)

- `BANNED_WRITE_TOOLS` splits: six names move to a `WRITE_TOOLS` list asserted **present**;
  `toggle_assignee` stays asserted **absent**. The "exactly the four" `/ticket|sprint/` filter assertion
  is rewritten against the new expected set (this is the surface's contract — keep it exhaustive).
- Table-driven over all six: non-assignee bearer → error result, and D1 untouched.
- Assignee bearer succeeds on all six, **including `transition_ticket → 'done'`** (D1, design §2).
- `create_ticket` is unscoped; requester is the bearer, not a client-supplied value; a bad handle in
  `assignees[]` is `bad_request` and leaves no half-built ticket.
- Illegal transition → conflict, nothing written. All four nesting rejections fire over MCP.
- The description test inverts: read tools no longer say "human-only"; write tools state the lane rule.

---

## Phase 3 — admin sprint writes

**Deliverables**

- `src/mcp.ts`, inside the existing `if (isAdmin(env, principal.handle))` block beside `update_plan`:
  `create_sprint`, `set_sprint_active`, `complete_sprint`, `add_sprint_resource`, thin over
  `src/tools/sprints.ts`. Inputs in **DTO vocabulary** (`label` / `due` / `active`), never column names.
- Descriptions note the deliberate delta (D5): `complete_sprint` is admin-only here although the cookie
  route is open to any member.

**Tests** (`test/mcp.sprints.writes.test.ts`, new)

- All four present for `admin-user`, absent from `tools/list` for `andres` and `beatrix`; calling one
  by name as a non-admin is tool-not-found.
- Each writes what the cookie route writes: `create_sprint` → `upcoming` / `Unscheduled` / `due: null`
  when unscheduled; `set_sprint_active` true/false mapping, the `done`-sprint no-op and re-open;
  `complete_sprint` → `done`; `add_sprint_resource` parses through the shared parser.
- `update_plan` still works unchanged alongside them (no regression in `test/mcp.plan.test.ts`).

---

## Phase 4 — the `tickets` skill (#46)

**Deliverables**

- `plugins/canopy/skills/tickets/SKILL.md` — `disable-model-invocation: true` (D9); `allowed-tools`
  limited to the ticket + sprint MCP tools; the four-step procedure in design §5 (orient → check the
  lane → one-line diff + confirm → one call, then report, refusals included); a `--dry-run` mode that
  prints the intended call and stops (#46's acceptance item).
- `plugins/canopy/skills/tickets/references/config.md` — the `tickets.config.md` key table (design §5),
  every key optional with its default, and an explicit statement that the config **cannot grant** what
  the Worker refuses (D8).
- `.claude/skills/tickets` symlink into the bundle, matching the other six.
- `plugins/canopy/.claude-plugin/plugin.json` updated if it enumerates skills.
- `plugins/canopy/skills/canopy/SKILL.md`: the tool map gains the write tools and the new skill; the
  "Tickets and sprints are read-only over MCP" paragraph is rewritten to the lane rule.

**Tests** — none (Markdown). Verify by hand that the symlink resolves and `plugin.json` parses.

---

## Phase 5 — docs and the invariant rewrite

**Deliverables** — every surface that asserts the old rule, exhaustively:

- `CLAUDE.md`, two paragraphs: *Core invariant* ("Tickets are the largest authored-write surface …
  NEVER MCP tools") and *Read side* ("MCP gets read tools only for tickets and sprints … and never
  will be"). Replace with the reworded invariant from design §2 — authored-write class unchanged,
  ingestion gate still uninvolved, `done`/`declined` still never **inferred**, and the lane + admin
  rules stated in one line each. Add a *Tickets from Claude Code* line under Working memory (#46).
- `plugins/canopy/skills/canopy/references/querying.md` — the read/write tool map.
- `docs/superpowers/plans/2026-09-16-canopy-tickets.md` — a dated note under §A pointing at this brief,
  so the older invariant list is not read as current. **Do not rewrite its verbatim brief quote.**
- Close #45 and #46 with a comment naming the decisions that landed and the three still open
  (design §8).

**Test** — full `npm test` + `npm run typecheck`; then `grep -rn "no MCP write path\|read tools only\|NEVER MCP tools\|human-only" CLAUDE.md src/ plugins/ docs/superpowers/specs/ web/` returns only intentional survivors (the confirm-verb rules, which genuinely are still web-only).

---

## V. Verifier protocol

Per phase, in order; any failure is reported with the evidence, not worked around:

1. `npm test` and `npm run typecheck` both green.
2. **The refusal-writes-nothing property**, re-checked by hand for one verb per phase: snapshot the
   ticket row + child tables, attempt a forbidden write, diff. (Global rule 4 is the one this design
   can silently break.)
3. `git diff --stat src/routes.ts src/tools/tickets.ts src/tools/sprints.ts` — the first must be empty;
   the latter two limited to the `TicketError` code union (global rule 2).
4. Phase 2 and 3: confirm from `tools/list` output — not from source — that `toggle_assignee` is absent
   for every principal and the sprint writes are absent for non-admins.
5. Phase 5: the grep above, plus a read of `CLAUDE.md`'s two paragraphs against design §2 line by line.
