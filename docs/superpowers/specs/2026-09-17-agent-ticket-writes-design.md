# Agent ticket & sprint writes over MCP — design (2026-09-17)

Closes the design half of issues #45 (ticket writes over MCP) and #46 (a Claude Code skill that
works the queue). The implementation brief is `docs/superpowers/plans/2026-09-17-agent-ticket-writes.md`.

Today (`0024`/`0025`, PR #44) MCP sees the ticket queue and the sprints through four read tools and
can write none of it: every ticket and sprint write is a session-cookie route under `sessionGate`.
This design opens the write half **without opening it wide** — the whole shape of it is one rule,
stated once here and enforced once in the Worker:

> **An agent writes only inside its principal's own lane.** A ticket write over MCP is permitted
> exactly when the bearer principal is **already an assignee of that ticket**. Filing a new ticket
> is the one unscoped write. Sprints are admin-only.

---

## 0. Decision ledger

Every judgment call this design makes, what it rejects, and what it costs. `D5` and `D6` are the two
worth re-reading before implementation starts — they are the ones a reasonable person could flip.

| # | Decision | Chosen | Rejected | Why | Consequence (what this costs) | Enforced where |
|---|---|---|---|---|---|---|
| **D1** | How much of the ticket screen becomes agent-reachable | **Full verb parity, including `done` / `declined`** — anything a person can do on the ticket screen, their agent can do over MCP | (a) low-stakes only (create/comment/link); (b) everything except the two resolving moves; (c) keep MCP read-only | The bearer token **is** the person. A token minted by Beatrix, acting on a ticket Beatrix owns, is Beatrix acting — withholding `done` from it withholds it from her, not from a machine | The fourth tickets invariant must be **reworded**, not kept verbatim (§2). An agent can close a ticket assigned to its principal | `src/mcp.ts` registrations |
| **D2** | What bounds that parity | **Assignee scope.** Every write verb but `create_ticket` requires the bearer to be in `ticket_assignees` for that ticket; otherwise a typed `forbidden` (403-class) error and **nothing is written** | (a) verb-scoping (ban resolving moves for everyone); (b) requester-scope (the filer, not the assignee); (c) no scope | Assignment is the queue's existing statement of "this is yours". Scoping to it needs no new concept, no new column and no new UI — the boundary is data the team already curates by hand | An agent cannot triage the org-wide queue, comment on a colleague's ticket, or pick work up off the unassigned pile. Picking work up stays a human act (D8) | `assertAssignee` in `src/tools/tickets-agent.ts` |
| **D3** | Whether assignment itself is agent-reachable | **Only at creation.** `create_ticket` accepts `assignees[]`; there is **no** `toggle_assignee` MCP tool, now or later | expose the toggle under assignee scope | Who owns what is the one field the scope rule is *built on*. An agent that can edit the assignee list can edit its own permissions | Re-assigning, unassigning and handing work over are web-only. An agent asked to "put Sana on this" reports that it cannot, and says why | tool absent from `src/mcp.ts`; asserted absent in tests |
| **D4** | Marking a write that arrived over MCP | **No provenance.** No `via` column on `ticket_events` / `ticket_comments` / `tickets`, no chip in the SPA | (a) `via` column + an "agent" marker on the history row; (b) column now, UI later | Two reasons, and the second is the load-bearing one. Mechanically, an agent's write under a person's token *is* that person's write (D1), so a marker would imply a distinction the authority model does not make. **Product-level: Canopy exists to be the connecting layer between agent and human knowledge.** A store that tagged every agent-touched row would be building the seam it was made to remove — a two-tier history where one tier is quietly trusted less. Confirmed by the product owner 2026-09-17 | **Irreversible for the interim.** `ticket_events.actor` and `ticket_comments.author` carry the handle and nothing else, so history can never separate a person's transition from their agent's. Adding the column later defaults old rows to `'web'`, which will be **wrong** for every MCP write made before it lands. Accepted deliberately | — (nothing to build) |
| **D5** | Sprint writes over MCP | **Admin-only**, conditionally registered exactly like `update_plan` — a non-admin principal does not see the four tools in `tools/list` at all | expose to every principal, matching the cookie routes | Sprints are the roadmap's shape; the admin plan write already owns them | **A deliberate delta from the web:** `POST /sprints/:id/complete` sits under the blanket `sessionGate` with *no* `adminGate`, so any signed-in member can complete a sprint from the UI — over MCP, `complete_sprint` is admin-only. The surfaces disagree on purpose, and §3 says so out loud | `isAdmin(env, principal.handle)` guard around the block |
| **D6** | Can an admin move **someone else's** ticket into a sprint over MCP | **Yes — `set_ticket_sprint` only.** The single exception to D2: admin ⇒ scope satisfied, for that one verb | (a) no exceptions, admins are agents too; (b) admin bypasses scope on every ticket verb | Composing a sprint *is* sprint management. Without it "edit sprints over MCP" is half a feature: an admin could create the container and never fill it | One verb where the lane rule does not hold. It is a `sprint_id` move — it re-homes a ticket, never resolves, comments on, or re-assigns it. **Flip point:** deleting the exception is a one-line change in `tickets-agent.ts` | `assertTicketWritable` admin branch |
| **D7** | MCP tool names | **Mirror the writer function names** — `create_ticket`, `transition_ticket`, `add_ticket_comment`, `add_ticket_link`, `set_ticket_sprint`, `set_ticket_parent` | the issue's sketch (`comment_ticket`, `assign_ticket`) | One vocabulary across `src/tools/tickets.ts`, the MCP surface and the skill. The existing `BANNED_WRITE_TOOLS` list in `test/mcp.tickets.test.ts` flips to a `WRITE_TOOLS` list with the **same strings** | `toggle_assignee` stays in the banned list (D3) — the list does not empty, it splits | `src/mcp.ts` |
| **D8** | Where the per-team guardrails live | **Both layers.** The Worker enforces the hard rules; a `tickets.config.md` the skill reads expresses the soft team preferences on top | (a) skill config only (advisory); (b) server only | A skill config binds only agents that honor the skill — a bearer token can call the tool directly regardless. So the invariants go in the Worker, and the config's job is to stop the skill from even *asking* for something the server would refuse | Two places to look when behavior surprises someone. §5 draws the line explicitly so it stays legible | `src/tools/tickets-agent.ts` + `plugins/canopy/skills/tickets/` |
| **D9** | Skill shape for #46 | **One skill, `disable-model-invocation: true`** (explicit-only), like `update-plan` and `record-session` | a read skill that auto-fires + a write skill that does not, mirroring `load-context`/`record-session` | The read half needs no skill: `list_tickets` / `get_ticket` / `list_sprints` / `get_sprint` are already registered for every principal and already documented in the `canopy` umbrella. A second auto-firing skill would add noise, not reach | "What's in the queue?" is answered by the agent calling the read tool directly, not by this skill firing | `plugins/canopy/skills/tickets/SKILL.md` frontmatter |
| **D10** | Self-assignment at creation | **Allowed.** An agent may file a ticket with `assignees: ["<itself>"]` and thereby unlock every scoped verb on it | forbid the bearer's own handle in `create_ticket.assignees` | The unlocked ticket is one the agent *filed*; every field it could later change it could have set at creation. The only genuinely new power is resolving it — a ticket the agent opened, in its own lane | A narrow, self-contained escalation path. **Named here so it is a decision, not an oversight**; D4 (no provenance) is what makes it invisible in history | — (accepted) |

---

## 1. The rule, precisely

```
create_ticket            → any bearer principal.          The one unscoped write.
transition_ticket        ┐
add_ticket_comment       │
add_ticket_link          ├→ bearer ∈ ticket_assignees(id).  Else: forbidden, nothing written.
set_ticket_parent        │   (set_ticket_sprint also passes for an admin — D6)
set_ticket_sprint        ┘
toggle_assignee          → NOT REGISTERED. Web only, forever. (D3)

create_sprint            ┐
set_sprint_active        ├→ isAdmin(bearer). Conditionally registered: absent from
complete_sprint          │   tools/list for everyone else, exactly like update_plan.
add_sprint_resource      ┘
```

**`set_ticket_parent` requires the scope on BOTH tickets.** The call writes `child.parent_id` and
bumps `parent.updated_at`; both rows are the subject of the write, so both must be in the bearer's
lane. This is the conservative reading and the easy one to relax — a reviewer who disagrees changes
one `assertTicketWritable` call.

**Scope is checked before the first mutation, never between them.** The existing writers already
validate everything up front for exactly this reason (`create_ticket`'s comment says so): D1 has no
transaction here, so a rejection must leave the database untouched, not half-written.

### Where it lives

A new thin module, `src/tools/tickets-agent.ts`, is the **only** thing `src/mcp.ts` calls for ticket
writes. Each wrapper asserts scope, then delegates to the untouched writer in `src/tools/tickets.ts`:

```ts
// src/tools/tickets-agent.ts — the MCP write surface. One rule, one place.
export async function assertTicketWritable(
  db: DB, env: Env, id: number, handle: string, verb: AgentVerb,
): Promise<void> {
  await getTicketRow(db, id);                       // 404 before 403 — an unknown id is not "forbidden"
  if (verb === "set_ticket_sprint" && isAdmin(env, handle)) return;   // D6, the one exception
  const mine = await first<{ n: number }>(db,
    `SELECT COUNT(*) AS n FROM ticket_assignees WHERE ticket_id = ? AND login = ? COLLATE NOCASE`, id, handle);
  if (!(mine?.n ?? 0)) throw new TicketError("forbidden", `ticket ${id} is not assigned to you`);
}
```

Three things this shape buys:

1. **The cookie routes do not change.** `src/tools/tickets.ts` keeps its signatures; `routes.ts` keeps
   calling it directly. A human on the web is not assignee-scoped and never was.
2. **The rule cannot be forgotten by a new verb**, because the test in §6 is table-driven over the
   registered tool names — a write tool added to `mcp.ts` without a wrapper fails the suite.
3. **`COLLATE NOCASE`** matches `persons.handle` and the ticket-list reads, so a case variant of a
   handle can never widen or narrow a lane.

`TicketError` gains a fourth code: `forbidden`, mapped in `TICKET_ERROR_STATUS` to **403**. The cookie
routes never produce it (they never pass a scope), so the web surface is untouched — but the mapping
is there so a future cookie caller gets the right status for free.

---

## 2. What happens to the invariants

The tickets brief (`docs/superpowers/plans/2026-09-16-canopy-tickets.md` §A) carries four invariants.
This design touches two of them, and **the change is a rewording, not a repeal**. Stated exactly:

| Brief invariant | Status | After |
|---|---|---|
| `/mcp` bearer-only, everything else cookie. No new credential class. | **Intact, untouched** | No new route, no new credential, no new gate. The bearer principal already in scope does all of it |
| Confirm verbs are cookie routes. **MCP gets read tools only.** | **Narrowed** | *Confirm verbs are cookie routes* still holds — promote / ratify / reject / triage-assign / discard are untouched and stay web-only. The second sentence becomes: **MCP gets read tools for everything, plus ticket writes inside the bearer's own lane and admin sprint writes.** |
| Every ticket write is a human authored write. No `consume()`, no staging, no proposals. | **Reworded, substance intact** | **Every ticket write is an authored write attributed to a person** — by that person over a session cookie, or by that person's agent over their bearer token, within their lane. Still no `consume()`, still no staging, still no proposals, still the promote class. The ingestion gate is not involved in any of this |
| **Done and Declined are set by a person. Nothing infers them, including PR merges.** | **Intact — and this is the crux** | The invariant was never "no agent may resolve a ticket". It is *nothing **infers** a resolution*: not a PR merging, not an issue closing, not every ticket in a sprint resolving, not the `scheduled()` cron, not the webhook. That remains absolutely true. An agent calling `transition_ticket(id, "done")` under Beatrix's token on Beatrix's ticket is **Beatrix saying so**, which is what the invariant asks for |

The same reasoning already governs the store: `record_session` writes under the bearer principal and
`update_plan` sets a sprint `done` under an admin's. Ticket writes now join them. The line Canopy
draws has always been **inference vs. authorship**, not human-fingers vs. agent.

**Doc surfaces that state the old rule and must change** (§5 of the brief lists the exact lines):
`CLAUDE.md` (two places — the tickets paragraph and the MCP read-side paragraph), the four read tools'
own descriptions in `src/mcp.ts` (they say "there is no MCP write path" — and a test asserts that
phrase), `plugins/canopy/skills/canopy/SKILL.md`, and `references/querying.md`.

---

## 3. The sprint surface

Four admin-only tools, thin over the existing writers in `src/tools/sprints.ts`, registered inside the
same `if (isAdmin(...))` block that already holds `update_plan`:

| Tool | Writer | Input (DTO vocabulary) |
|---|---|---|
| `create_sprint` | `create_sprint` | `SprintCreate` — `label` required; `dates` / `summary` / `description` / `urgency` / `due` / `lead` / `domain` / `phase` |
| `set_sprint_active` | `set_sprint_active` | `{ id, active }` — `true` → `in_progress`, `false` → `upcoming`; on a `done` sprint `false` is a no-op and `true` re-opens |
| `complete_sprint` | `complete_sprint` | `{ id }` → status `done` |
| `add_sprint_resource` | `add_sprint_resource` | `{ id, raw }` — parsed by the shared link parser |

The **DTO vocabulary rule holds**: the tool inputs speak `label` / `due` / `active`, never `title` /
`target_date` / `status`. Only `src/tools/` speaks columns (`shared/sprints.ts` header).

`update_plan` is not replaced and not deprecated. It stays the bulk, versioned, narrative-plus-sprints
write (snapshotting into `plan_versions`); these four are the per-sprint verbs the Roadmap screen
offers. An admin agent reshaping the whole plan still uses `update-plan`; one flipping a single sprint
active uses `set_sprint_active`. The brief's Phase 3 note stands: **which tickets are in a sprint is
not an `update_plan` concern** — that is `set_ticket_sprint` (D6).

---

## 4. Worked scenarios

What the rule actually feels like, including the three refusals — these are the acceptance cases.

| Ask | Outcome |
|---|---|
| "File a ticket for the CSV export bug, put it on me" | `create_ticket { title, category:'bug', assignees:['andres'] }` → **ok**. Unscoped write; the agent may set assignees here and only here (D3) |
| "Start the login ticket" (Andres is an assignee) | `transition_ticket { id, to:'in_progress' }` → **ok** |
| "Mark it done" (same ticket) | `transition_ticket { id, to:'done' }` → **ok**. This is the person saying so through their token (D1) |
| "Mark it done" (Andres is *not* an assignee) | **forbidden** — `ticket 12 is not assigned to you`. Nothing written, no `ticket_events` row |
| "Decline Sana's access request" | **forbidden**, same shape. The agent reports it and points at the web UI |
| "Put Sana on this ticket" | **No such tool.** The agent says assignment is web-only after creation, and why (D3) |
| "Move this to sprint 13" (own ticket) | `set_ticket_sprint` → **ok** |
| "Move Beatrix's ticket into sprint 13" (admin) | **ok** via the D6 exception. (Non-admin: forbidden) |
| "Move this back to submitted from done" | **conflict** — `done` is terminal in `canTransition`. The same 409-class refusal the web gets; the table is not re-declared for MCP |
| "Nest #31 under #30" (assignee of both) | `set_ticket_parent` → **ok**, subject to the four existing nesting rejections |
| "Nest #31 under #30" (assignee of #31 only) | **forbidden** — both rows are the subject of the write (§1) |
| "Add a sprint for Q4 notifications" (admin) | `create_sprint` → **ok**. Non-admin: the tool is not in `tools/list` at all |
| "Complete sprint 12" (non-admin) | **Not in `tools/list`** — even though the same person *can* do it in the web UI (D5) |

---

## 5. The two guardrail layers (D8)

**Hard — the Worker.** Non-negotiable, binding on every bearer whether or not a skill is installed:
assignee scope (D2); the admin gate on sprint verbs (D5); `canTransition` (the one table in
`shared/tickets-core.ts`, never re-declared); handle validation via `requirePerson`; the four nesting
rejections; the absence of `toggle_assignee` (D3).

**Soft — `tickets.config.md`**, read by the skill from the repo root (or `.claude/`), all keys
optional with the stated defaults:

| Key | Default | Meaning |
|---|---|---|
| `default_category` | `other` | Category for tickets the agent files when none is stated |
| `default_priority` | `normal` | Same, for priority |
| `landing_sprint` | *(backlog)* | `backlog` \| `active` \| a sprint id — where a filed ticket lands |
| `self_assign_on_create` | `true` | Whether the agent puts its principal on tickets it files (the D10 lever, in the team's hands) |
| `offer_transitions` | `all` | Which moves the skill will propose; a team that wants a human to close things sets `submitted→in_progress` only. **Advisory** — the server will still accept the rest |
| `comment_prefix` | *(none)* | Prepended to every comment the agent posts, so its comments are recognizable in the absence of provenance (D4) |
| `require_confirmation` | `true` | Show the one-line diff and wait, before any write |
| `link_repo` | `SaplingLearn/sapling` | Repo a bare `#214` resolves against — must match `DEFAULT_TICKET_REPO` in `shared/tickets.ts` |

The config **cannot grant** anything the Worker refuses. Its whole job is the opposite: keep the skill
from proposing a write that will come back `forbidden`, and encode the team's taste about the writes
that *are* permitted. The skill states this in its own text so nobody mistakes it for a permission
system.

### Skill procedure (#46)

`plugins/canopy/skills/tickets/SKILL.md`, explicit-only (D9), `allowed-tools` limited to the ticket +
sprint MCP tools. Four steps, in the house style of `update-plan`:

1. **Orient before writing** — `list_tickets` / `get_ticket` / `get_sprint`. Never write from the
   conversation's memory of a ticket; read it back, the way `record-session` reads docs back.
2. **Check the lane first.** `get_ticket` already returns `assignees` — if the principal is not among
   them, say so and stop, rather than calling a tool that will refuse.
3. **One-line diff, then confirm** (unless `require_confirmation: false`): the exact fields about to
   be sent. `--dry-run` prints the intended call and stops — the acceptance item from #46.
4. **One tool call, then report what changed**, including the refusals, in the words of §4.

---

## 6. Test obligations

Everything drives the **real registered closures** over `InMemoryTransport` via `buildCanopyMcpServer`,
the way `test/mcp.tickets.test.ts` already does — never the writer functions directly, so a missing or
renamed registration is a failure rather than a green.

- **Surface flip.** `test/mcp.tickets.test.ts`'s `BANNED_WRITE_TOOLS` splits: the six ticket write
  names become `WRITE_TOOLS` (must be present); `toggle_assignee` stays banned (D3); the four sprint
  writes are present for `admin-user` and absent for `andres` / `beatrix`.
- **Scope, table-driven over every scoped verb.** A non-assignee bearer gets `forbidden` **and D1 is
  untouched** — assert the ticket row is byte-identical and that no `ticket_events` / `ticket_comments`
  / `ticket_links` row appeared. A rejection that writes something is the failure mode that matters.
- **Assignee bearer succeeds** on each of the six, including `transition_ticket → 'done'` — the
  explicit codification of D1 and the reworded invariant.
- **`create_ticket` is unscoped**, and the requester is the **bearer**, not any client-supplied field
  (the same rule `/ingest` applies to `session.author`).
- **Shared rules still bite over MCP**: an illegal transition is a conflict that writes nothing; all
  four nesting rejections fire; an unknown handle in `assignees[]` is a `bad_request`; an unknown
  ticket id is `not_found` (**404 before 403** — an unknown id must not leak as "forbidden").
- **`set_ticket_parent` needs both lanes** (assignee of the child only → forbidden).
- **D6**: an admin moves a ticket they are not assigned to into a sprint → ok; a non-admin → forbidden;
  and the admin exception does **not** extend to `transition_ticket` on that same ticket.
- **Sprint writes**: each of the four succeeds for an admin; `complete_sprint` is admin-only over MCP
  even though the cookie route is not (D5) — assert both halves, since that delta is deliberate.
- **Descriptions**: the four read tools no longer claim "no MCP write path"; the write tools' text
  states the lane rule (the existing description test inverts rather than disappears).

No test covers the skill or its config — they are Markdown. The `canopy` umbrella's tool map is
updated by hand, as it always has been.

---

## 7. What this does not do

- **No provenance, no UI.** Nothing in `web/` changes. (D4)
- **No new credential class, no new route, no new migration.** The whole feature is registrations in
  `src/mcp.ts` plus one ~60-line module. `0025` remains the head migration.
- **The ingestion gate is not involved.** Ticket and sprint writes stay direct promote-class writes.
  This is not a second ingestion surface, and the rule in `CLAUDE.md` — *when adding an ingestion path,
  add it to the gate* — is not in play here.
- **Confirm verbs stay web-only**: promote, ratify, reject, triage assign/discard. Unchanged.
- **Assignment stays web-only** after creation. (D3)
- **`create_ticket` cannot nest.** The web create screen has no parent picker either; nesting is a
  second call to `set_ticket_parent`, which needs the lane on both.

---

## 8. Reviewer calls — all three confirmed (2026-09-17)

The three decisions a reasonable person could have flipped were put to the product owner before
implementation and confirmed as built. Kept here with their flip points, because the next reader's
question will be "could this have gone another way, and how would I change it".

1. **D6 — an admin may move someone else's ticket between sprints.** Confirmed. Flip point: delete the
   one `if` in `assertTicketWritable`. Cost of flipping: an admin agent can create a sprint but not
   staff it.
2. **D10 — an agent may self-assign at creation**, and so may later resolve a ticket it filed.
   Confirmed. Two levers, in increasing strength: `self_assign_on_create: false` in a team's
   `tickets.config.md` (binds only agents that honour the skill), or the server rejecting the bearer's
   own handle in `create_ticket.assignees` (binds everyone).
3. **D4 — no provenance.** Confirmed, with the product rationale now recorded in the ledger above: the
   store is the connecting layer between agent and human knowledge, and a `via` tag would rebuild the
   seam it exists to remove. This one had a closing window and it is now closed by choice — writes made
   from here on are indistinguishable from clicks, and a column added later would default them to
   `'web'`. That is the accepted state, not an oversight to fix.
