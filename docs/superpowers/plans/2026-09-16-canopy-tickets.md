# Canopy tickets — implementation brief (2026-09-16)

The shared brief every phase subagent (implementer AND verifier) reads first. It carries the
product brief verbatim (§A), the locked design's binding judgment calls (§B), the repo-state
adjustments that reconcile the brief with the code as it exists today (§C), the global rules
(§D), and one section per phase (§1–§6) with exact deliverables and the tests that must be
written. The verifier protocol and the audit format are in §V.

Design source of truth: `Canopy Frontend Design System/Canopy Tickets.dc.html` (locked). Its
`<script data-dc-script>` block (line ~1100 onward) holds the seed data and handlers that are the
behavioral spec wherever this brief is silent. Read the template markup for the screens you build.

---

## A. The brief (verbatim, from the product owner)

> One ticket queue the whole org files into. Non-engineering staff are the main filers, but every
> org member sees every screen and anyone can be assigned. There is no role concept and no
> requester shell. Sign-in is unchanged: GitHub OAuth, active org membership required.
>
> Tickets are D1 rows, never GitHub issues (ADR-007 in the design). A ticket may link to GitHub or
> Figma work; it never is that work. Tickets can nest one level (parent and sub-tickets). Sprints
> are the container: a sprint holds tickets and is what the Roadmap shows. Tickets in a sprint drive
> that sprint's progress the same way GitHub issues drive a milestone's today, and a ticket assigned
> to you appears on My Work next to your assigned issues.
>
> ### Invariants
> - /mcp bearer-only, everything else cookie. No new credential class.
> - Confirm verbs are cookie routes. MCP gets read tools only.
> - Every ticket write is a human authored write. No consume(), no staging, no proposals.
> - Done and Declined are set by a person. Nothing infers them, including PR merges.
>
> ### Phase 1: schema and contract
>
> Migration 0023_tickets.sql:
>
> tickets
> - id INTEGER PK AUTOINCREMENT
> - title TEXT NOT NULL
> - body TEXT NOT NULL DEFAULT ''
> - category TEXT NOT NULL CHECK IN ('bug','request','question','access','other') DEFAULT 'other'
> - priority TEXT NOT NULL CHECK IN ('low','normal','high') DEFAULT 'normal'
> - status TEXT NOT NULL CHECK IN ('submitted','in_progress','done','declined') DEFAULT 'submitted'
> - requester TEXT NOT NULL REFERENCES users(github_login)
> - parent_id INTEGER REFERENCES tickets(id)  (one level: a ticket with a parent cannot itself be a parent; enforce in the route, not the schema)
> - sprint_id INTEGER REFERENCES sprints(id)  (NULL = backlog)
> - created_at, updated_at TEXT NOT NULL
>
> ticket_assignees: ticket_id, login, PK (ticket_id, login). Many per ticket.
> ticket_links: id, ticket_id, url, kind CHECK IN ('github','figma','plain'), label, meta, created_by, created_at
> ticket_comments: id, ticket_id, author, body, created_at
> ticket_events: id, ticket_id, actor, from_status (nullable), to_status, created_at. One row per status change plus the opening row.
>
> tickets_fts: fts5(ticket_id UNINDEXED, title, body, tokenize = 'porter unicode61') with insert/update/delete triggers. Idempotent like 0011 (DROP IF EXISTS first). wrangler d1 export cannot dump virtual tables and the recreate was missed once already.
>
> Migration 0024_sprints.sql:
>
> Sprints are milestones renamed. Same row, same purpose, new label and a few new fields. Do not create a parallel table.
> - ALTER TABLE milestones RENAME TO sprints (SQLite supports it; then rebuild any index or trigger that named the old table)
> - title stays as the label; target_date stays as the due date; status maps to active (in_progress -> 1, else 0). Keep the columns, add a view or map in the read model, do not copy data around.
> - ADD COLUMN dates TEXT, phase TEXT, summary TEXT, urgency TEXT CHECK IN ('low','normal','high') DEFAULT 'normal', lead TEXT, domain TEXT CHECK IN ('notifications','tickets','gate','feed','search','infra')
> - description becomes markdown (the design renders bold, code, links, h3, bullets)
> - github_ref keeps its JSON shape so event-derived issue progress still works
>
> sprint_resources: id, sprint_id, url, kind, label, meta
>
> The approval system goes: DROP TABLE milestone_proposals, remove the proposal routes, the propose_milestone MCP tool, the Review-surface block that listed them, and their tests. This replaces the parked "milestone queue retirement" item. Rename every remaining milestone identifier in src/, shared/, web/, tests, the local plan-push skill, and docs to sprint. grep -ri milestone must come back empty except the migration history.
>
> shared/tickets.ts and shared/sprints.ts: Zod for every row, the DTOs the routes return, create payloads, and the transition payload.
>
> Status transitions, one function, enforced everywhere:
> - submitted -> in_progress (Start) | declined
> - in_progress -> done | submitted (Back)
> - done, declined terminal
>
> Link parsing lives in shared/ so the SPA and the server agree: bare `#214` or `214` resolves to https://github.com/SaplingLearn/sapling/issues/214; github.com issues/pull URLs -> kind github with label `repo #n` and meta `GITHUB · ISSUE` or `GITHUB · PULL REQUEST`; other github.com -> kind github; figma.com -> kind figma with the last path segment as label; anything else -> kind plain with the hostname as label.
>
> Tests: transition table exhaustively; parent nesting rejected past one level; FTS rows appear and disappear; pre-existing milestone rows read back as sprints with the right active flag; link parser on all five shapes.
>
> ### Phase 2: ticket routes
>
> All cookie, all under sessionGate, all direct authored writes:
>
> - POST /tickets  { title (required), body, category, priority, assignees[], sprint_id, link? }  Requester = principal. Writes the opening ticket_events row. If a link is given, parse and insert it.
> - GET /tickets?seg=open|closed|all&assignee=anyone|me|unassigned&category=  Open = submitted + in_progress. Sort updated desc. Returns assignees, link count, parent_id, sub count, sprint label per row.
> - GET /tickets/:id  Full DTO: assignees, links, comments, events, parent summary, children summaries.
> - POST /tickets/:id/status { to }  Validates transition, writes event.
> - POST /tickets/:id/assignees { login, on: bool }  Toggle, no confirm.
> - POST /tickets/:id/links { raw }  Parse and insert.
> - POST /tickets/:id/sprint { sprint_id | null }
> - POST /tickets/:id/parent { child_id }  Sets child.parent_id = :id. Reject if :id has a parent, if child has a parent, if child is done or declined, or if child has children.
> - POST /tickets/:id/comment { body }
> - GET /tickets/badge  Count of tickets with no assignees and status in (submitted, in_progress). Sidebar badge.
>
> Search: add tickets_fts to the /search fan-out with the same bm25 and title weight.
>
> Tests: every route, transition rejection, nesting rejection, assignee toggle idempotent, badge count.
>
> ### Phase 3: sprint routes and the roadmap
>
> - POST /sprints  { label (required), dates, summary, description, urgency, due, lead, domain }  Created unscheduled and inactive from the Roadmap's New sprint panel.
> - GET /sprints  Each with computed: total tickets, closed (done + declined), pct, distinct assignee logins.
> - GET /sprints/:id  Sprint plus its tickets ordered roots then children (a child whose parent is outside the sprint is a root), plus resources = sprint_resources union all ticket_links in the sprint, deduped by url.
> - POST /sprints/:id/active { active: bool }
> - POST /sprints/:id/resources { raw }
>
> Roadmap read model: the existing plan layer becomes sprints. In Progress = active sprints, Upcoming = inactive. Progress bar = closed/total where total counts tickets in the sprint plus GitHub issues resolved through github_ref via the existing event-derived path. A sprint with no tickets and no github_ref shows 0/0.
>
> The local skill that pushes the plan layer now writes sprints. Update it and its docs.
>
> Tests: progress math with tickets only, issues only, both; root/child ordering; resource dedupe; renamed rows still render.
>
> ### Phase 4: MCP
>
> Read tools only in src/tools/reads.ts, registered in src/mcp.ts: list_tickets (seg, assignee, category), get_ticket, list_sprints, get_sprint. Agents can see what has been asked for and what is in the sprint; they cannot write any of it.
>
> ### Phase 5: SPA
>
> Screen union gains tickets, ticketdetail, newticket, sprint. Match the design frame for frame:
>
> - Sidebar: Tickets after Feed, icon in the 18px 1.8 stroke family, green badge from /tickets/badge.
> - Queue: header with New ticket button and a Table / Board toggle using the Roadmap tab idiom. Filter row: Open / Closed / All segment, assignee select (Any assignee, Assigned to me, Unassigned), category select. Table view groups rows under each sprint (active sprint labeled ACTIVE in green) with a BACKLOG group last and an "Open sprint →" link per group; empty groups hidden. Board view is columns per status in the current segment. Row: title, category, priority chip (monochrome), status pill (submitted blue, in_progress green, done muted, declined red at reduced opacity), stacked assignee avatars or italic Unassigned, sub-ticket relation text ("2 sub" or "↳ sub-ticket"), sprint tag, age. Unassigned + submitted rows get the 2px inset left rule and faint fill. Footer count: "N shown · M unassigned".
> - New ticket: title (only required field, placeholder "One line: what do you need?"), category chips (none selected = other), priority segment defaulting normal, description ("What's happening, and what would good look like?"), sprint chips (Backlog default), assignee chips (Unassigned default, multi), link field ("GitHub or Figma URL, or #issue-number"). Submit returns to queue with a toast.
> - Ticket detail: breadcrumb back to Tickets. Title, category, priority, status pill, opened age, requester. Description. Linked work chips (GitHub, Figma, plain each with their icon and meta). Link field visible only until at least one link exists, after that the "Linked to engineering work" line. Parent line if any. Sub-tickets list with an add menu whose candidates exclude self, its parent, anything with a parent, anything with children, and anything closed. Sprint rail with a menu (Backlog plus each sprint). Assignee picker toggles immediately. Transition buttons show only legal moves: Start / Decline from submitted, Done / Back from in_progress, nothing when terminal. Comment thread and box. History list: who, from → to, when; the opening row reads "opened · SUBMITTED".
> - My Work: third block "Tickets assigned to me", To-do card treatment, status not done or declined, sorted updated desc. Empty copy: "No tickets assigned to you. The queue has what's waiting."
> - Roadmap: cards are sprints. Card shows label, summary, phase and dates, urgency tag (▲ HIGH amber, NORMAL, LOW), DUE tag, DOMAIN tag (blue), lead avatar and first name, member avatars, progress bar, "closed/total done", NEXT UP badge on inactive. New sprint panel with the Phase 3 fields; urgency segment, lead chips, domain chips. Timeline / Narrative tabs unchanged.
> - Sprint screen: title, dates, phase, tags, description rendered from markdown, ticket list with children indented under roots and a ↳ chevron, resources list, members.
> - Settings: add the "Ticket queue" cadence row.
> - DashboardData in shared/dashboard.ts gains tickets: MyWorkTicket[]. Do not put them in todo.
>
> ### Phase 6: email
>
> Add ticketq to src/notifications/registry.ts: label "Ticket queue", description "New and unassigned tickets across the org.", default daily. Renderer lists submitted tickets with no assignees, then tickets assigned to the recipient that are not closed. Add ticketq to the Maintenance admin policy rows (the design omitted it; it must be disableable org-wide like the other three). No per-event mail.
>
> Tests: outbox rows and idempotency keys; a run with no qualifying tickets writes no row.
>
> ### How to run
>
> Work phase by phase. For each phase spawn one subagent to implement and a second, independent subagent that only reads the diff and runs the suite to verify; the verifier writes the phase section of the audit. Do not let the implementer write its own audit. Keep going until all six phases are green and the audit is written; do not stop to ask unless a phase cannot be made green.
>
> Phases in order. Full suite green after each; do not proceed on red. Do not apply migrations to prod; I do. Add two non-engineer logins to the dev seed and identity fixture so the queue has requesters who are not the four of us.
>
> When done, write canopy-tickets-audit.md: per phase, file and line, command, output. A test that stays green when the change is reverted does not count.

---

## B. The design's nine judgment calls (binding)

From the Changelog screen of `Canopy Tickets.dc.html`:

1. Tickets is one shared surface for the whole org — no separate requester shell. Anyone submits from the header button; anyone can be assigned. Everyone sees the same screens.
2. Tickets sits at the end of Workspace, after Feed; the icon is drawn in the sidebar family (18px, 1.8 stroke, no fill). The green badge counts unassigned active tickets.
3. Filters collapsed into one Open / Closed / All segment plus two selects — the status vocabulary is fixed, so per-status chips were noise.
4. Two views: Table for scanning, Board grouped by status for working the queue. The toggle uses the Roadmap tab idiom in the header.
5. Status pills are tinted: Submitted blue, In progress green, Done muted, Declined red. Priority chips are monochrome.
6. "Needs attention" (unassigned + Submitted) is a 2px inset left rule plus a faint fill — the selected-card idiom, not a new color.
7. Assignment from the picker is immediate — reversible, so no confirm step. Legal status moves only: Submitted → Start/Decline; In progress → Done/Back.
8. The GitHub link field shows only until a link exists; after that, the plain "Linked to engineering work" line.
9. My Work gains a third block, "Tickets assigned to me", with the To-do card treatment; Settings gains one "Ticket queue" cadence row.

Design seed facts worth knowing (from the x-dc script): statuses are displayed as `Submitted` / `In progress` / `Done` / `Declined` (pill text uppercased); the pill/priority/tag styles are the `pill()` / `prioSt()` / `tint()` helpers; `parseLink()` is the reference link parser; `sprStats()` is the reference progress math; `relCandidates` is the reference sub-ticket candidate filter; `spRoots` / `spTickets` is the reference root-then-children ordering; `spResources` is the reference resource dedupe (by url, first wins); `mwTix` is the reference My Work ticket filter; `md()` shows which markdown the sprint description must render (bold, code, links, `###` headings, `- ` bullets — our `web/src/markdown.ts` already covers this).

---

## C. Repo-state adjustments (decided; do not re-litigate)

The brief was written against an older snapshot. These are the reconciliations:

1. **Migration numbers.** `0023_persons.sql` already exists (identity cutover, 2026-09-16). Tickets are `migrations/0024_tickets.sql`; sprints are `migrations/0025_sprints.sql`.
2. **No `users` table.** The identity root is `persons(handle)` (see CLAUDE.md › Identity). Every person-bearing column in the new tables (`tickets.requester`, `ticket_assignees.login`, `ticket_links.created_by`, `ticket_comments.author`, `ticket_events.actor`, `sprints.lead`) stores a **person handle**. Use `REFERENCES persons(handle)` only where a hard FK is safe (requester); assignee/lead/actor columns are plain TEXT handles (same as `notification_prefs.user_id`) so historical rows survive a person deletion. Keep the column name `login` on `ticket_assignees` as the brief says; document that it holds a handle. **Add every one of these columns to `HANDLE_COLUMNS` in `src/auth/persons.ts`** so a rename rewrites them (`test/rename-handle.test.ts` iterates that list — extend its seeding helper for the new tables).
3. **`propose_milestone` is already gone** from MCP. What remains and must go: the `milestone_proposals` table (DROP in 0025), `ingestMilestoneProposal` in `src/consumer.ts`, `MilestoneProposal` in `shared/contract.ts`, `stage_/promote_/reject_milestone_proposal` in `src/tools/writes.ts`, `list_milestone_proposals` in `src/tools/reads.ts`, the three routes in `src/routes.ts` (`GET /milestone-proposals`, `POST /milestone-proposals/:id/promote|reject`), the `"milestone"` assign kind (`AssignType`, `assign_triage` branch, `web/src/triage-map.ts` ASSIGN_OPTIONS "Roadmap note", `web/src/maintenance.ts` copy), `web/src/api.ts` client fns, the `milestone_proposals` block in `fixtures/dev/triage.json` + `scripts/seed/build.mjs`, and every test that exercised them (`test/roadmap.test.ts` gate block, `test/triage-reads.test.ts` proposal blocks, `test/triage-writeback.test.ts` reject block, `test/rename-handle.test.ts` seeding, `test/triage-map.test.ts` / `test/render.review.test.ts` assign-kind expectations, `test/seed-coverage.test.ts` "four queues"). CLAUDE.md's Staged-write › Milestones paragraph is rewritten to describe sprints.
4. **The rename scope.** Rename every Canopy-owned "milestone" identifier to "sprint" in `src/`, `shared/`, `web/`, `test/`, `scripts/`, `fixtures/`, `plugins/canopy/skills/` (`.claude/skills` is a symlink to it — edit once), `CLAUDE.md`, `README.md`, `wrangler.toml` comments. Concretely: table `milestones`→`sprints`, `milestone_progress`→`sprint_progress` (column `milestone_id`→`sprint_id`), `plan_versions.milestones_json`→`sprints_json`, index `idx_milestones_target_date`→`idx_sprints_target_date`, the `roadmap_fts` synthetic ref `milestone:<id>`→`sprint:<id>` and its triggers (`roadmap_fts_sprint_ai/au/ad`), `MilestoneRow`→`SprintRow`, `MilestoneProgressRow`→`SprintProgressRow`, `PlanView.milestones`→`sprints`, query type `"milestone"`→`"sprint"` (contract enum, MCP tool enum, `/search` types csv, web `QueryType` + search chips/labels), `MilestoneWithProgress`, `roadmapEnriched`, `milestoneRefChips`, `confirmedMilestones`, `confirmMilestone` act, `completeMilestone` api fn, route `POST /milestones/:id/complete`→`POST /sprints/:id/complete`, `complete_milestone`→`complete_sprint`, `update_plan`'s `milestones` arg→`sprints`, `PlanMilestoneInput`→`PlanSprintInput`, `recomputeAllProgress` / `applyEventProgress` internals, notification renderer `diffMilestones`→`diffSprints` (and the kind's copy: "Sprints added, changed, reordered, or confirmed done."), `roadmap_plan` label stays.
   **Exempt (GitHub's own vocabulary, not Canopy's):** the GitHub payload field `milestone` on issues/PRs (`src/webhook.ts`, `src/tools/backfill.ts`, `src/tools/mywork.ts` `RawIssue.milestone`, `test/fixtures/gh-*.json`), the GitHub REST path `/milestones/:n`, and the To-do card's "Milestone" row (`MyWorkTodo.milestone` = the GitHub milestone an issue belongs to, rendered on My Work and in the my_work email). A `github_ref` that is a bare number IS a GitHub milestone number — comments may say so. **Also exempt:** `migrations/` (history), `docs/superpowers/**` dated specs/plans (records of past builds), `canopy-spec.md` / `canopy-orchestrator.md` (the previous build's spec), the locked design HTML, and the parked worktree `.claude/worktrees/` (not ours). The Phase 1 verifier records the residual `grep -rli milestone` list with a one-line justification per hit in the audit.
5. **`phase` already exists** on `milestones` (0012). 0025 must not re-add it. `description` is already TEXT; "becomes markdown" is a render-side change (the roadmap card and sprint screen render it through `renderMarkdown`).
6. **Sprint status.** Keep the `status` column (`upcoming | in_progress | done`). `active` is derived: `status === 'in_progress'`. `POST /sprints/:id/active {active:true}` sets `in_progress`; `{active:false}` sets `upcoming`. `done` stays admin-only (plan write or `POST /sprints/:id/complete`). Roadmap groups: **In Progress** = active, **Upcoming** = `upcoming`, and the existing **Done** group stays for `done` sprints (the design's seed has none, so it is silent; keeping the group preserves today's behavior and tests).
7. **Field naming across the seam.** DB columns keep their names (`title`, `target_date`). The DTO (`SprintView` in `shared/sprints.ts`) exposes the design's vocabulary: `label` (= title), `due` (= target_date), `active` (derived), plus `summary`, `description`, `phase`, `dates`, `urgency`, `lead`, `domain`, `github_ref`, `status`, timestamps, and the computed `progress: { closed, total, pct }` and `members: string[]`. `PlanView.sprints` is `SprintView[]`. The `update_plan` MCP input and the `POST /sprints` body use the DTO vocabulary (`label`, `due`, …); `status` remains on `update_plan` so an admin can set `done`.
8. **Progress math** (one function, `src/tools/sprints.ts` `sprintProgress`): `total = ticketsInSprint + (cache?.total ?? 0)`, `closed = ticketsDoneOrDeclined + (cache?.closed ?? 0)`, `pct = total ? round(100*closed/total) : 0`, where `cache` is the `sprint_progress` row (event-derived, via `github_ref`). No tickets and no cache → `0/0`.
9. **Non-engineer seed.** Two Google-only persons (no github identity, so they never collide with event subjects): `meilin` (Meilin Zhao, color `rose`) and `sanaok` (Sana Okafor, color `ochre`), each with a `google` identity row. They go in `scripts/seed/reset.mjs` (the canonical person seed for tests AND the dev loader) and in a new `fixtures/dev/tickets.json` (the design's seven seed tickets + comments + events + links, requesters meilin/sanaok, assignees from the four engineers) and `fixtures/dev/roadmap.json` gains the sprint fields + `sprint_resources` for two sprints. `scripts/seed/build.mjs` inserts them. Tests that count persons (e.g. anything asserting four persons) are updated.
10. **`.claude/worktrees` pollution.** `vitest.config.ts` now excludes `**/.claude/**` so the parked worktree's copy of `test/` is not run (done before Phase 1; the pre-change baseline showed 163 files because of it).
11. **Ticket ids in URLs.** SPA hash routes: `#tickets`, `#tickets/new`, `#tickets/<id>`, `#sprints/<id>`. `screenFromHash` parses these into `screen` + `ticketId` / `sprintId`.
12. **Where code lives.** Ticket + sprint read functions (`list_tickets`, `get_ticket`, `list_sprints`, `get_sprint`, plus `ticket_badge`) live in `src/tools/reads.ts` (the brief says so); ticket writers in `src/tools/tickets.ts`, sprint writers + progress math in `src/tools/sprints.ts` (plan.ts keeps `write_plan`/`get_plan` and imports from sprints.ts). Routes in `src/routes.ts`. SPA views in new `web/src/tickets.ts` (queue / new / detail) and `web/src/sprints.ts` (roadmap cards, new-sprint panel, sprint screen) as pure functions over props, wired from `render.ts` / `main.ts` (the review.ts / maintenance.ts idiom).

---

## D. Global rules (every phase)

- Read `CLAUDE.md` first. Then this file. Then the design file's script block and the template for the screens in your phase.
- `npm test` (real Miniflare D1) AND `npm run typecheck` must both be green before a phase is done. `npm run build:web` must succeed after Phase 5.
- Test the real call path: drive live routes via `app.request(...)` with `cookieFor(handle)` from `test/helpers/persons.ts`, and registered MCP tools via `buildCanopyMcpServer` + `InMemoryTransport` (see `test/roadmap.test.ts` for the pattern). A test that would stay green if the change were reverted is not a test.
- A test under `test/` that imports anything from `web/src` MUST be listed by name in BOTH `tsconfig.worker.json` `exclude` and `tsconfig.web.json` `include`.
- New data tables go in `scripts/seed/reset.mjs` `RESET_STATEMENTS` (FK-safe order: `ticket_events`, `ticket_comments`, `ticket_links`, `ticket_assignees`, `tickets`, `sprint_resources` before `sprints`; `sprint_progress` before `sprints`).
- Every stored person handle column goes in `HANDLE_COLUMNS`.
- Never call `consume()` / the gate for tickets or sprints. They are direct authored writes (promote class), exactly like `write_plan`.
- Never set ticket `done`/`declined` or sprint `done` from anything but a human route / the admin plan write.
- Do not touch `.claude/worktrees/`, `migrations/0001`–`0023`, or the design HTML.
- Do not apply migrations to remote D1. Never deploy. Never push.
- Commit at the end of your phase on branch `feat/tickets` with a conventional message (`feat(tickets): …`), ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do not commit if the suite is red.
- A `GEMINI_API_KEY` in `.dev.vars` leaks into the vitest pool and fails ONE pre-existing summarizer test ("GEMINI_API_KEY unset in tests → excerpt") — environmental, not yours; note it and move on.

---

## 1. Phase 1 — schema and contract

Split into two sequential implementers (1a, 1b) and one verifier.

### 1a — tickets schema + shared contract

Deliverables:
- `migrations/0024_tickets.sql`: the five tables exactly as §A lists them (adjusted per §C.2), `tickets_fts` + `tickets_fts_ai` / `_au` (AFTER UPDATE OF title, body) / `_ad` triggers, DROP IF EXISTS first (mirror `0011_fts_recreate.sql`'s shape and its export-caveat comment), backfill `INSERT … SELECT`. Note: `sprints` does not exist until 0025, so `tickets.sprint_id` is `INTEGER` with a comment that 0025 introduces the target table (SQLite does not enforce FKs across a later rename anyway; keep the `REFERENCES sprints(id)` clause — SQLite accepts a forward reference at CREATE time).
- `shared/tickets.ts`: Zod schemas `TicketCategory`, `TicketPriority`, `TicketStatus`, `TicketRow`, `TicketAssigneeRow`, `TicketLinkRow`, `TicketCommentRow`, `TicketEventRow`; DTOs `TicketListItem` (row + `assignees: string[]`, `link_count`, `sub_count`, `sprint_label: string | null`), `TicketDetail` (row + `assignees`, `links`, `comments`, `events`, `parent: {id,title,status} | null`, `children: {id,title,status}[]`, `sprint: {id,label} | null`); payloads `TicketCreate` (title min 1, body default '', category default 'other', priority default 'normal', assignees default [], sprint_id nullable optional, link optional string), `TicketTransition` (`to`), `TicketAssigneeToggle`, `TicketLinkAdd`, `TicketSprintSet`, `TicketParentSet`, `TicketCommentAdd`; list filters `TicketSeg` (`open|closed|all`), `TicketAssigneeFilter` (`anyone|me|unassigned`).
- Transitions in `shared/tickets.ts`: `TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]>` = `{ submitted: ['in_progress','declined'], in_progress: ['done','submitted'], done: [], declined: [] }`, `canTransition(from, to)`, `legalMoves(status)`; `TICKET_STATUS_LABEL` = `{ submitted: 'Submitted', in_progress: 'In progress', done: 'Done', declined: 'Declined' }`; `isOpenStatus(s)`.
- Link parser in `shared/tickets.ts`: `parseTicketLink(raw: string, repo = 'SaplingLearn/sapling'): ParsedLink | null` returning `{ url, kind, label, meta }`, byte-for-byte the design's `parseLink` semantics: trims; empty → null; non-http(s) → `https://github.com/<repo>/issues/<raw sans leading #>`; `github.com/<owner>/<repo>/(issues|pull)/<n>` → kind `github`, label `<repo> #<n>`, meta `GITHUB · ISSUE` or `GITHUB · PULL REQUEST`; other github.com → kind `github`, label = path after `github.com/` sliced to 40 chars (or `GitHub`), meta `GITHUB`; figma.com → kind `figma`, label = last path segment (split on `?`, `[-_]+`→space, first letter capitalized, fallback `Design file`), meta `FIGMA · DESIGN`; else kind `plain`, label = hostname sans `www.` (fallback `link`), meta `LINK`. Also reject non-http(s) absolute schemes (`javascript:` …) → null.
- `shared/rows.ts` re-exports the ticket row types (or points at `shared/tickets.ts`); `scripts/seed/reset.mjs` gains the DELETEs; `src/auth/persons.ts` `HANDLE_COLUMNS` gains the ticket columns.
- `test/tickets.contract.test.ts`: the transition table exhaustively (all 16 from→to pairs), `legalMoves` per status, the link parser on all five shapes (+ bare `214`, `#214`, a `javascript:` scheme → null, trailing whitespace). `test/tickets.schema.test.ts`: insert a ticket → `tickets_fts` row appears; update title → FTS reflects; delete → FTS row gone; harness truncation leaves no FTS leak; CHECK constraints reject a bad category/priority/status.

### 1b — sprints migration, proposal removal, rename

Deliverables:
- `migrations/0025_sprints.sql`: `ALTER TABLE milestones RENAME TO sprints`; drop + recreate the target_date index under the new name; drop the three `roadmap_fts_milestone_*` triggers and create `roadmap_fts_sprint_ai/au/au-of(title, description, phase, status, summary)/ad` writing ref `'sprint:' || id` with body = description ∥ summary ∥ phase ∥ status; `DELETE FROM roadmap_fts WHERE ref LIKE 'milestone:%'` then backfill `sprint:` rows; `ALTER TABLE milestone_progress RENAME TO sprint_progress; ALTER TABLE sprint_progress RENAME COLUMN milestone_id TO sprint_id`; `ALTER TABLE plan_versions RENAME COLUMN milestones_json TO sprints_json`; `ADD COLUMN dates TEXT`, `summary TEXT`, `urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high'))`, `lead TEXT`, `domain TEXT CHECK (domain IN ('notifications','tickets','gate','feed','search','infra'))` (SQLite ALTER ADD COLUMN accepts CHECK; a NOT NULL column needs a non-null default — urgency has one); `CREATE TABLE sprint_resources (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id INTEGER NOT NULL REFERENCES sprints(id), url TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('github','figma','plain')), label TEXT NOT NULL, meta TEXT NOT NULL)`; `DROP TABLE milestone_proposals`. Comment the file with what each rename is for. Verify with `PRAGMA foreign_key_list(sprint_progress)` in a test that the FK now points at `sprints`.
- `shared/sprints.ts`: Zod `SprintUrgency`, `SprintDomain`, `SprintStatus`, `SprintRow` (DB columns), `SprintResourceRow`, `SprintView` (§C.7), `SprintDetail` (`SprintView` + `tickets: SprintTicketRow[]` with `depth: 0|1`, + `resources: {url,kind,label,meta}[]`), `SprintCreate` (`label` min 1; `dates`, `summary`, `description`, `due`, `lead`, `domain` optional/nullable; `urgency` default `normal`), `SprintActiveSet`, `SprintResourceAdd`; `sprintActive(row)`, `toSprintView(row, progress, members)`.
- The removal in §C.3 and the rename in §C.4, end to end, including `plugins/canopy/skills/update-plan/SKILL.md` + `read-plan/SKILL.md` + `canopy/SKILL.md` + `canopy/references/querying.md`, `CLAUDE.md`, `README.md`. `update_plan` MCP arg becomes `sprints: [{ id?, label, summary?, description?, phase?, dates?, due, status, urgency?, lead?, domain?, github_ref? }]`; `write_plan` writes all sprint columns; `plan_versions.sprints_json` snapshots `SprintRow[]`.
- `get_plan` returns `PlanView { narrative, version, updated_at, updated_by, sprints: SprintView[] }` — for Phase 1 the ticket counts are 0 (no tickets joined yet; Phase 3 adds them), so `progress` = the cache only. Keep the `target_date ASC, id ASC` order.
- `scripts/seed/reset.mjs`: the two Google-only persons (§C.9), table renames, drop the proposals DELETE. `fixtures/dev/roadmap.json` rows get `summary`/`dates`/`urgency`/`lead`/`domain` (invent sensible values; `phase` exists), `scripts/seed/build.mjs` writes them (tickets fixture is Phase 2's job). `fixtures/dev/triage.json` loses `milestone_proposals`.
- Tests: `test/sprints.schema.test.ts` — apply migrations, insert a row with the legacy shape (title/target_date/status in_progress) and read it back via `get_plan` as a sprint with `active: true`; `upcoming` → `active:false`; `sprint_progress` FK targets `sprints`; `roadmap_fts` has `sprint:<id>` refs and no `milestone:` refs; `milestone_proposals` no longer exists (`sqlite_master`). Update every renamed test. `test/query.roadmap.test.ts` asserts ids `sprint:<id>` and type `"sprint"`.
- Final check the verifier will run: `grep -rli milestone --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude --exclude-dir=.wrangler --exclude-dir=dist --exclude-dir=migrations --exclude-dir="Canopy Frontend Design System" --exclude-dir=docs .` must list only the §C.4-exempt files, and inside those only GitHub-vocabulary hits.

---

## 2. Phase 2 — ticket routes

- `src/tools/tickets.ts`: `create_ticket(db, input, requester)` (inserts ticket, assignees, opening `ticket_events` row `{actor: requester, from_status: null, to_status: 'submitted'}`, parsed link if given), `transition_ticket(db, id, to, actor)` (throws on illegal move; writes the event; bumps `updated_at`), `toggle_assignee(db, id, login, on)` (idempotent: `INSERT OR IGNORE` / `DELETE`; bumps `updated_at`), `add_ticket_link(db, id, raw, by)`, `set_ticket_sprint(db, id, sprintId|null)` (404 on unknown sprint), `set_ticket_parent(db, parentId, childId)` (the four rejections from §A + parent === child + unknown ids), `add_ticket_comment(db, id, body, author)` (body trimmed, min 1). Every write bumps `tickets.updated_at`. All person columns store handles; the `login` in the assignee toggle must be an existing `persons.handle` (400 otherwise).
- `src/tools/reads.ts`: `list_tickets(db, { seg, assignee, category, me })` returning `TicketListItem[]` (one query for rows + grouped queries for assignees / link counts / sub counts / sprint labels — no N+1), `get_ticket(db, id)` → `TicketDetail | null`, `ticket_badge(db)` → number. `query()` gains type `"ticket"` over `tickets_fts` with `bm25(tickets_fts, 1.0, 5.0, 1.0)`, authority `live`, id `ticket:<id>`, title = title, body = body; browse mode = `updated_at DESC`. Add `"ticket"` to the contract enum, the MCP `query` enum, the `/search` types csv, and the web `QueryType` + search chip ("Tickets") + type badge/icon + open attr (`openTicket`).
- `src/routes.ts`: the ten routes from §A. **Register `GET /tickets/badge` before `GET /tickets/:id`.** `assignee=me` resolves against `c.get("principal").handle`. Bodies validated with the `shared/tickets.ts` payload schemas → 400 with issues. Illegal transition / nesting → 409 with `{ error }`. Unknown ticket → 404.
- `fixtures/dev/tickets.json` (§C.9) + `scripts/seed/build.mjs` insertion + `test/seed-coverage.test.ts` asserts the queue lights up (badge > 0, a ticket with links, a parent with a child).
- Tests (`test/tickets.routes.test.ts`): every route through `app.request`, 401 without cookie; create sets requester = principal and ignores any client `requester`; opening event row; list filters (seg/assignee/category) and sort; per-row assignees/link_count/sub_count/sprint_label; detail DTO shape; transition table via the route (legal 200 + event row; illegal 409 + no event); assignee toggle idempotent (on twice → one row; off twice → zero rows); nesting: all four rejections + success; sprint set/unset; link parse via route; comment; badge count (unassigned open only). `test/query.fts.test.ts` gains a tickets case (a ticket title term ranks; `include_staged:false` still returns it).

---

## 3. Phase 3 — sprint routes and the roadmap

- `src/tools/sprints.ts`: `create_sprint(db, input, author)` (status `upcoming`, `phase` = input.phase ?? `'Unscheduled'`, `target_date` = `due` ?? '' — decide: `target_date` is NOT NULL, so a sprint without a due date stores `''` and the DTO exposes `due: null`; document it), `set_sprint_active(db, id, active)`, `complete_sprint(db, id)` (the renamed `complete_milestone`), `add_sprint_resource(db, id, raw)`, `sprintProgress(...)` (§C.8, one pure function over `{ticketsTotal, ticketsClosed, cache}`), `sprintMembers` (distinct assignee handles over the sprint's tickets), `list_sprints(db)` → `SprintView[]` (target_date ASC, id ASC; blank `target_date` last), `get_sprint(db, id)` → `SprintDetail | null` with tickets ordered roots then children (root = no parent OR parent outside the sprint; roots by `updated_at DESC`; children under their root by `updated_at DESC`, `depth: 1`) and resources = `sprint_resources` ∪ ticket links of the sprint's tickets, deduped by url (first occurrence wins, sprint resources first).
- `get_plan` now uses `list_sprints` so `PlanView.sprints[].progress` counts tickets + cache; `GET /roadmap`, MCP `get_roadmap`, and the notification `roadmap_plan` renderer keep working (the snapshot diff ignores progress).
- Routes: `POST /sprints`, `GET /sprints`, `GET /sprints/:id`, `POST /sprints/:id/active`, `POST /sprints/:id/resources`, plus the renamed `POST /sprints/:id/complete`.
- Skill update: `plugins/canopy/skills/update-plan/SKILL.md` documents the sprint vocabulary (`label`, `due`, `summary`, `dates`, `urgency`, `lead`, `domain`, `status` incl. `done`) and that sprint membership of tickets is set from the Tickets UI, not the plan write; `read-plan/SKILL.md` reads sprints + ticket-inclusive progress.
- Tests (`test/sprints.routes.test.ts`): progress math tickets-only / issues-only (seed `sprint_progress`) / both / neither (0/0); root/child ordering incl. a child whose parent is in another sprint (renders as root); resource dedupe (same url in `sprint_resources` and a ticket link appears once); `POST /sprints` creates inactive + unscheduled; active toggle both ways; complete; resources via raw parse; 401s. `test/roadmap.test.ts` / `test/plan.test.ts`: renamed rows still render through `GET /roadmap` and `get_roadmap` with `active` flags.

---

## 4. Phase 4 — MCP read tools

- In `src/mcp.ts` register `list_tickets` (`seg`, `assignee` — for MCP `me` = the bearer principal, `category`), `get_ticket` (`id`), `list_sprints` (), `get_sprint` (`id`), each `runTool(() => …)` over the Phase 2/3 read functions. Descriptions say read-only and that ticket writes are human-only in the web UI.
- Tests (`test/mcp.tickets.test.ts`): drive the registered tools over `InMemoryTransport`; `tools/list` contains the four and contains NO ticket/sprint write tool (assert none of `create_ticket`, `transition_ticket`, `set_ticket_*`, `create_sprint`, `set_sprint_active` exist); `assignee:'me'` resolves to the principal; `get_ticket` unknown id → `{ error }` with `isError`.

---

## 5. Phase 5 — SPA

Read the design template for frames 1–4 (queue, new ticket, detail, my work) and the roadmap/sprint/settings markup before writing. Match it frame for frame. Everything is inline-style template strings over `canopy.css` vars, `data-act`/`data-arg` dispatched in `main.ts` (see `review.ts` / `maintenance.ts` for the componentized-view idiom).

- `web/src/api.ts`: `listTickets(filters)`, `getTicket(id)`, `createTicket(body)`, `transitionTicket(id,to)`, `toggleAssignee(id,login,on)`, `addTicketLink(id,raw)`, `setTicketSprint(id,sprintId)`, `setTicketParent(parentId, childId)`, `addTicketComment(id,body)`, `getTicketBadge()`, `listSprints()`, `getSprint(id)`, `createSprint(body)`, `setSprintActive(id,active)`, `addSprintResource(id,raw)`, `completeSprint(id)`. Types re-exported from `@shared/tickets` / `@shared/sprints`.
- `render.ts`: `Screen` gains `"tickets" | "ticketdetail" | "newticket" | "sprint"`; `AppState` gains `tickets: Loadable<TicketListItem[]>`, `ticketDetail: Loadable<TicketDetail|null>`, `ticketId: number|null`, `ticketBadge: number`, `qSeg`, `qAssignee`, `qCategory`, `qView: 'table'|'board'`, `qMenu`, the new-ticket form fields (`fTitle`, `fCat`, `fPrio`, `fDesc`, `fAsgs`, `fGh`, `fSpr`), detail-only UI state (`commentDraft`, `ghDraft`, `lkOpen`, `asgMenu`, `sprMenu`, `relMenu`), `sprints: Loadable<SprintView[]>`, `sprintDetail: Loadable<SprintDetail|null>`, `sprintId`, the new-sprint panel fields (`nsOpen`, `nsName`, `nsDates`, `nsDesc`, `nsUrg`, `nsDue`, `nsLead`, `nsDom`). `header()` titles: tickets/ticketdetail/newticket → "Tickets", sprint → "Roadmap"; the breadcrumb (title becomes a back button + "›" crumb) for ticketdetail / newticket / sprint per the design's `titleBtnSt`/`crumbSt`; the New ticket button and Table/Board toggle only on `tickets`; the roadmap tabs also on `roadmap` only.
- Sidebar: Tickets nav after Feed, icon = the design's ticket SVG (18px, 1.8 stroke, no fill), badge from `ticketBadge` in the accent-pill style (expanded) / accent dot (collapsed), hidden at 0; `[data-screen="tickets"|"ticketdetail"|"newticket"] .cnpy-nav.n-tickets` active rule in `canopy.css`; `[data-screen="sprint"]` highlights Roadmap.
- `web/src/tickets.ts`: `queueView(props)` (filter row, table view grouped by sprint with ACTIVE label, BACKLOG last, "Open sprint →", hidden empty groups, needs-attention rule, footer count; board view = one column per status in the segment with empty dashed placeholder), `newTicketView(props)`, `ticketDetailView(props)` (the design's frame 3: header block, description, linked work chips with GitHub/Figma/plain icons + meta, link field ↔ "Linked to engineering work" line, parent line, sub-tickets + add menu with the candidate filter, sprint rail + menu, assignee picker, transition buttons via `legalMoves`, comment box, thread merged with history sorted by time, opening row "opened · SUBMITTED"). Pure functions over props; status pills via one `ticketPill(status)` helper implementing call #5; priority chips monochrome; avatars via `personChip` from `./people`.
- `web/src/sprints.ts`: `sprintCard(view)` (label, summary, phase · dates, urgency/DUE/DOMAIN tags, lead avatar + first name, member avatars, progress bar, "closed/total done", NEXT UP on inactive), `newSprintPanel(state)`, `sprintScreen(detail)` (title, dates, phase, tags, description via `renderMarkdown`, ticket list with `depth:1` rows indented with the ↳ chevron, resources list with icons, members). The roadmap Timeline tab renders sprint cards in the In Progress / Upcoming (/ Done) groups; Narrative tab unchanged.
- My Work: third `mwSection("Tickets assigned to me", …)` after To-do, `ticketCard(t)` in the To-do card treatment (title + `#id` pill linking to `#tickets/<id>`, Summary row = body excerpt, Requester row, Sprint row, footer: status pill + priority chip + "updated <rel>"), empty copy exactly "No tickets assigned to you. The queue has what's waiting." Data from `DashboardData.tickets` (`MyWorkTicket { id, title, body, category, priority, status, requester, sprint: {id,label}|null, updatedAt, createdAt }`), which `getMyWork` fills (open tickets where the handle is an assignee, `updated_at DESC`, cap 6 like the other lists) — **never in `todo`**.
- Settings: the "Ticket queue" row appears automatically once Phase 6 registers the kind (Settings iterates the registry); Phase 5 adds nothing here but verifies the row renders when the kind exists (write the render test in Phase 6).
- `main.ts`: hash routing (§C.11), loaders (`loadTickets`, `loadTicketDetail`, `loadTicketBadge` — badge refreshed on app boot and after every ticket write —, `loadSprints`, `loadSprintDetail`), the dispatch cases for every `data-act` (queue filters/view/menus, form fields, submit → toast copy from the design's `submitTicket`, detail actions with the design's toast copy, sprint create/active/resource), all following the existing `Unauthorized → re-auth`, `ApiError → flash` pattern. Ticket writes reload the detail + badge (+ queue if cached).
- Tests (`test/render.tickets.test.ts`, `test/render.sprints.test.ts`, listed in both tsconfigs): queue grouping/order/empty-group hiding/needs-attention rule/footer count/board columns per segment; new-ticket submit button disabled until title; detail shows only legal transition buttons per status, link field vs linked line, sub-ticket candidates filter, opening history row; My Work third block + empty copy + tickets not in todo; sidebar badge hidden at 0 / shown; roadmap card tags/NEXT UP/progress text; sprint screen child indentation + resource list; `screenFromHash` parsing (export a pure helper for it).
- `npm run build:web` must pass.

---

## 6. Phase 6 — email

- `src/notifications/renderers/ticket-queue.ts`: kind `ticketq`, label "Ticket queue", description "New and unassigned tickets across the org.", `defaultCadence: 'daily'`, `allowedCadences: ['daily','weekly','off']`, deep link `/#tickets`, link label "Tickets". Renderer: section 1 = `submitted` tickets with no assignees (org-wide, newest first), section 2 = tickets assigned to the recipient handle with status not done/declined (`updated_at DESC`); null when both are empty; HTML via the `EMAIL_CARD`/`EMAIL_STYLE` helpers like the other renderers, text alternative too; summary line "N unassigned · M assigned to you".
- Register in `REGISTRY` (fourth). `ensureNotificationPolicySeeded` already seeds from the registry; the Maintenance policy rows iterate `registryMeta()` so `ticketq` appears there — add an explicit test that `GET /api/notifications/policy` lists it and that `enabled:0` removes it from the Settings prefs view.
- Tests (`test/notifications.ticketq.test.ts`): renderer null on no qualifying tickets; lists unassigned submitted tickets; lists the recipient's open assigned tickets and not closed/others'; escapes HTML; `runDigest` writes one outbox row with the kind in `kinds` and the usual idempotency key, a second run for the same window writes nothing new; a run where the only kinds render null writes `skipped`; a user with no qualifying tickets and no other sections → `skipped` row, no body. `test/render.notifications.test.ts`: the Settings row "Ticket queue" renders from a prefs view carrying the kind.

---

## V. Verifier protocol and audit format

The verifier is independent: it does not edit product code. It (1) reads `git diff <phase-base>..HEAD` (or the working tree) for the phase, (2) runs `npm test` and `npm run typecheck` (and `npm run build:web` from Phase 5 on), (3) for at least two of the phase's tests, reverts the relevant production change (`git stash` a hunk, or comment the line) and confirms the test goes red, then restores, (4) runs any grep the phase specifies, (5) writes its section of `canopy-tickets-audit.md` at the repo root.

Audit section format (one per phase):

```
## Phase N — <name>  (commit <sha>)

### Delivered
- <file>:<line> — <what>  (one bullet per deliverable, exact paths and line numbers)

### Commands
$ npm test
<the summary lines: files/tests passed/failed, duration>
$ npm run typecheck
<output>
(+ build:web, greps, PRAGMA checks as relevant — verbatim output)

### Revert checks
- <test name> — reverted <file>:<line> (<how>) → <the failing assertion line>, restored → green

### Gaps / deviations
- <anything the phase left out, any deviation from §A with the reason>
```

If the verifier finds a defect, it reports it back (in its final message) with file:line and the failing command; the orchestrator sends the implementer back before the phase is accepted. The verifier's audit section is written only for the accepted state.
