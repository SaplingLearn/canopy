# Canopy tickets — delta between the first pass and the corrected spec

Branch `feat/tickets` (PR #44), first pass HEAD `3c9aa9e` + audit commit. This file lists, per item,
what the first pass built, what the corrected spec says, and the action taken. The verifier writes
its result next to each item after the fix lands.

**Source.** The corrected spec was supplied inline in the follow-up brief ("canopy-tickets: second
pass, reconcile and finish"); no `canopy-tickets.md` file exists at the repo root or in git, so that
message text is the spec this delta is audited against. The design
(`Canopy Frontend Design System/Canopy Tickets.dc.html`) was already in the repo from the first pass.

## Per-phase delta index

| Phase | Spec says | First pass | Delta |
|---|---|---|---|
| 1 schema | `0023_tickets.sql`, `0024_sprints.sql`; `requester REFERENCES users(github_login)` | `0024_tickets.sql`, `0025_sprints.sql` (0023_persons already existed); `requester REFERENCES persons(handle)` (users was dropped in 0023) | Numbering and identity root differ by necessity — ruled in the first pass, kept. No corrective migration. |
| 1 rename | `grep -ri milestone src shared web test` empty | residue remains | see Confirmations → finish the rename |
| 2 routes | ten routes; comment stores raw text; no feed writes; tickets NOT in `/search` | ten routes ✓; raw text ✓; no feed writes ✓; tickets ARE in `/search` | item 4 |
| 3 sprints | progress = tickets only; `github_ref` kept for the Narrative tab; no cascade between parent/child sprints | progress = tickets + GitHub cache; no cascade ✓ | item 5, item 6 (confirm) |
| 4 MCP | four read tools, no writes | ✓ | confirm |
| 5 SPA | one Thread with "opened this ticket" / "From → To"; @mention chips; no ticket id anywhere; copy corrections; Settings row default daily | thread interleaved but opening row reads `opened · SUBMITTED`; mentions ✓; `#id` pill on the My Work ticket card; stale "milestone" copy | items 1, 2 (confirm), 7, 8 |
| 6 email | `ticketq` daily, in policy + Settings | ✓ | confirm |

Label note: the spec says "Post enabled only with text"; the design's button reads **Comment** and is
inert until the box has text. The design's label is kept (the design is binding on copy); the
behavior matches the spec.

## Migrations not yet applied to prod

| Migration | What it does |
|---|---|
| `0024_tickets.sql` | Creates `tickets`, `ticket_assignees`, `ticket_links`, `ticket_comments`, `ticket_events` and the `tickets_fts` virtual table + triggers (idempotent, DROP IF EXISTS first). |
| `0025_sprints.sql` | `ALTER TABLE milestones RENAME TO sprints` (in place, no copy); adds `dates`, `summary`, `urgency`, `lead`, `domain`; renames `milestone_progress` → `sprint_progress` (`milestone_id` → `sprint_id`) and `plan_versions.milestones_json` → `sprints_json`; re-keys `roadmap_fts` refs `milestone:<id>` → `sprint:<id>`; creates `sprint_resources`; `DROP TABLE milestone_proposals`. |

No item below needs a schema change, so no `0026` is added by this follow-up. Apply 0024 then 0025
before merging (`npm run db:migrate:remote`); a push to `main` auto-deploys.

## The eight known changes

### 1. Ticket detail thread
- **First pass:** ONE interleaved thread — comments and status events merged and sorted by
  timestamp (`web/src/tickets.ts` ~line 505–535); no separate History list. The opening event row
  reads `opened · SUBMITTED` (the first brief's wording) and later rows read `From → To`.
- **Spec:** one Thread, interleaved by timestamp; event rows read `opened this ticket` or `From → To`.
- **Action:** change the opening-row copy to `opened this ticket` (the design's `dThread.move`) and
  update the render test that pinned the old string. No structural change.
- **Verifier result:** PASS — `web/src/tickets.ts:527-529`: `ev.from_status === null` now yields the
  literal `"opened this ticket"`, later rows `${TICKET_STATUS_LABEL[from]} → ${TICKET_STATUS_LABEL[to]}`.
  Structure re-read at `web/src/tickets.ts:511-556`: comments and events push into ONE `ThreadRow[]`,
  `rows.sort((a,b) => a.ts - b.ts)` (`:549`), rendered under the single `THREAD` eyebrow (`:553`) —
  no History heading anywhere in the file. Matches the design script
  (`Canopy Tickets.dc.html:1505` `move: h.from ? h.from + " → " + h.to : "opened this ticket"`).
  Covering test `test/render.tickets.test.ts:652-665` (pins the string, asserts `opened · SUBMITTED`
  absent, asserts opening-row index < later-row index) and `:667-679` (interleave order).
  Revert: replaced the literal with the old `` `opened · ${…}` `` template →
  `npx vitest run test/render.tickets.test.ts` → `FAIL … AssertionError: expected '<div style="max-width:1000px…' to contain 'opened this ticket'`,
  `1 failed | 66 passed`. Restored via `git checkout -- web/src/tickets.ts`.

### 2. @mentions in comments
- **First pass:** present — `mentionize()` in `web/src/tickets.ts` (~424–436) escapes the body,
  then paints `@login` or `@Firstname` that resolves to an org member as an accent chip showing the
  first name; raw text is stored (`ticket_comments.body`); nothing notifies.
- **Spec:** the same.
- **Action:** none beyond confirming a render test covers both the handle and first-name forms and
  a non-member `@name` stays plain text (add if missing).
- **Verifier result:** PASS — `web/src/tickets.ts:425-437` (`mentionize`): escapes FIRST (`esc(text)`)
  then replaces `/@([A-Za-z0-9_-]+)/g`, looking the name up in a map keyed by BOTH
  `p.handle.toLowerCase()` and `(p.name || p.handle).split(" ")[0].toLowerCase()` — a hit becomes the
  accent chip carrying `firstNameOf(...)`, a miss returns `whole` unchanged. Same shape as the design's
  `mention()` (`Canopy Tickets.dc.html:1485-1500`). Raw text stored: `src/routes.ts:448-454` passes
  `parsed.data.body` straight to `add_ticket_comment`, which only `.trim()`s before the INSERT
  (`src/tools/tickets.ts:222-233`) — no mention rewriting on the write path.
  Covering test `test/render.tickets.test.ts:690-708`: `@meilin` (handle) and `@Sana` (first name) both
  produce the exact chip span, `<b>hi</b>` comes back escaped, `@nobody` survives as plain text and is
  asserted NOT chipped. Verbatim storage additionally verified by a scratch edit to the route test
  `test/tickets.routes.test.ts:603-621` — body `"  Reproduced @meilin <b>raw</b> — fix in progress.  "`
  read back as `"Reproduced @meilin <b>raw</b> — fix in progress."` → `1 passed`; restored.
  (Note: no permanent route-level test uses an `@` body; the stored-verbatim assertion at
  `test/tickets.routes.test.ts:612` uses a plain body. The Action did not ask for one.)
  Revert: commented out the first-name key in `mentionize` → `npx vitest run test/render.tickets.test.ts`
  → `FAIL … escapes comment bodies and paints known @mentions … expected … to contain '<span style="color:var(--accent);font…'`,
  `1 failed | 66 passed`. Restored.

### 3. Feed
- **First pass:** no ticket or sprint action writes to `feed` (grep of `src/tools/tickets.ts`,
  `src/tools/sprints.ts`, `src/routes.ts` for feed writes is empty; no test asserts a feed row from
  a ticket action).
- **Spec:** tickets never write to the feed.
- **Action:** none; add one negative assertion (a create + transition + comment leaves `feed` empty).
- **Verifier result:** PASS — `grep -n feed src/tools/tickets.ts src/tools/sprints.ts src/tools/plan.ts`
  returns ONE hit, `src/tools/plan.ts:22`, which is the `domain` vocabulary literal
  `"notifications" | "tickets" | "gate" | "feed" | …` on a sprint — not a write. `grep -n "feed"
  src/routes.ts` returns only the reader `GET /feed` (`:72-81`), the `get_feed` import (`:11`) and the
  `/search` type filter (`:89-90`); no `INSERT INTO feed` on any ticket or sprint route.
  Covering tests `test/tickets.routes.test.ts:637-660` (create + status → in_progress + comment +
  assignee + sprint + link + parent + status → done through the real routes, `SELECT id FROM feed`
  stays 0 while `tickets`/`ticket_comments`/`ticket_events` fill) and `:664-672` (`POST /sprints` +
  `POST /sprints/:id/active` write no feed row).
  Revert: added `INSERT INTO feed (author, summary, created_at) …` to `create_ticket` →
  `npx vitest run test/tickets.routes.test.ts -t "never write to the feed"` →
  `AssertionError: no ticket action writes to 'feed': expected 2 to be +0`. Restored.

### 4. Search
- **First pass:** tickets ARE in the `/search` fan-out — `query()` in `src/tools/reads.ts` has a
  `"ticket"` type over `tickets_fts` (bm25 1/5/1), the type is in `shared/contract.ts` enums, the
  MCP `query` tool enum, the `/search` csv filter (`src/routes.ts`), the web `QueryType`
  (`web/src/api.ts`), and the Search screen has a "Tickets" chip + `openTicket` card action
  (`web/src/render.ts` ~1051, ~1084).
- **Spec:** `tickets_fts` stays populated; tickets are NOT in the `/search` fan-out; no Tickets chip.
- **Action:** remove the `"ticket"` query type end to end (engine, contract, MCP enum, route filter,
  web type, chip, open action); keep `0024`'s `tickets_fts` table and its three triggers untouched;
  rewrite the tickets cases in `test/query.fts.test.ts` to assert a ticket title term returns NO
  ticket results while `tickets_fts` still holds the row; keep `test/tickets.schema.test.ts` FTS
  trigger tests as they are.
- **Verifier result:** PASS — `grep -n '"ticket"' shared/contract.ts src/mcp.ts src/routes.ts
  src/tools/reads.ts web/src/api.ts web/src/render.ts` returns exactly ONE line,
  `shared/contract.ts:65`, and it is the explanatory comment `// NOTE: no "ticket" — tickets_fts
  exists but tickets are NOT in the /search fan-out`. Per surface: `shared/contract.ts:67,78,95`
  enums are `["doc","decision","feed","sprint"]`; `src/mcp.ts:50` same; `src/routes.ts:89-90` the
  `/search` csv filter narrows to the same four; `src/tools/reads.ts:344` `type QueryType` is the
  four and `:425` the default list — `grep -n tickets_fts src/tools/reads.ts` returns only the
  comment at `:341`, so there is no `tickets_fts` candidate, no ticket bulk-hydration, no
  `c.type === "ticket"` assemble branch; `web/src/api.ts:93` `QueryType` is the four;
  `web/src/render.ts:1014/1017` icon+label maps have no `ticket` key, `:1054-1059` `searchOpenAttr`
  has no `openTicket` case, `:1092-1094` the chip list is `all/doc/feed/decision` with a comment
  saying why there is no Tickets chip. `migrations/` untouched:
  `git diff --stat 5cf3941..e47389d -- migrations` is EMPTY, and `migrations/0024_tickets.sql:125-143`
  still carries `tickets_fts` + `tickets_fts_ai/au/ad`.
  Covering tests `test/query.fts.test.ts:141` ("tickets are NOT in the search fan-out — a ticket title
  term returns no ticket, though tickets_fts holds the row") and `test/query.mcp-route.test.ts`
  (live MCP `query` inputSchema contains `sprint`, not `"ticket"`; MCP, `/search` and
  `/search?types=ticket` all return none); `test/tickets.schema.test.ts:108-174` trigger tests
  untouched.
  Revert (as directed, a scratch re-add rather than a git revert): re-inserted a `tickets_fts`
  candidate block + a ticket assemble branch into `query()` →
  `npx vitest run test/query.fts.test.ts` →
  `AssertionError: expected [ 'ticket:1', 'tamarind-doc', '9' ] to not include 'ticket:1'`,
  `1 failed | 8 passed`. Restored via `git checkout -- src/tools/reads.ts`.

### 5. Roadmap progress
- **First pass:** `sprintProgress()` in `src/tools/sprints.ts` = tickets in the sprint PLUS the
  `sprint_progress` cache (GitHub issues via `github_ref`); the Timeline bar, the Narrative spotlight,
  `GET /sprints`, MCP `get_sprint`, and the `query()` sprint body all show the combined number.
- **Spec:** closed/total over the sprint's tickets only; closed = done + declined. Keep `github_ref`
  so the Narrative tab's issue counts still resolve.
- **Action:** `progress` becomes tickets-only everywhere (bar, "closed/total done", ready-to-complete
  rule, `GET /sprints`, `GET /sprints/:id`, MCP, `query()` sprint body). Add a separate
  `issues: { closed, total } | null` on `SprintView` fed from the `sprint_progress` cache (via
  `github_ref`), and render it ONLY in the Narrative tab spotlight ("N/M issues closed" + the
  issue chips). The webhook/cron progress writers and `github_ref` are untouched. Update the
  progress tests: tickets-only / issues-only (bar 0/0, `issues` 2/3) / both / neither.
- **Verifier result:** PASS — `src/tools/sprints.ts:77-83`: `sprintProgress({ ticketsTotal,
  ticketsClosed })` returns those two verbatim plus a rounded pct; `SprintProgressInput`
  (`:64-71`) no longer has a `cache` field at all, so the cache cannot be smuggled in. The GitHub
  half is the new pure `sprintIssueCounts(cache)` (`:87-88`), and `viewOf` (`:171-185`) passes it as
  `toSprintView`'s FOURTH argument (`shared/sprints.ts:176-206`), never into `progress`. Matches the
  design's `sprStats` (`Canopy Tickets.dc.html:1571-1577` — tickets in the sprint, closed = Done +
  Declined). `SprintView.issues` sourced from the `sprint_progress` cache: `list_sprints` reads it via
  `getProgress` (`src/tools/sprints.ts:160-168`), `viewFor` via
  `SELECT * FROM sprint_progress WHERE sprint_id = ?` (`:203`).
  Surfaces on `progress`: Timeline card `web/src/sprints.ts:113-134` (bar + "closed/total done"),
  sprint screen `web/src/sprints.ts:356-357`, `GET /sprints` `src/routes.ts:490`, `GET /sprints/:id`
  (both through `list_sprints`/`get_sprint`), MCP `list_sprints`/`get_sprint` (`src/mcp.ts:160,167`),
  and the `query()` sprint body (`src/tools/reads.ts:400-425` — `assembleSprintBody` no longer takes
  the cache and `:576-579` no longer calls `getProgress`). `issues` renders in exactly one place: the
  Narrative spotlight, `web/src/render.ts:968-982` (`N/M issues closed` beside the chips, nothing when
  null) — `grep -n "\.issues\b" web/src/render.ts` shows only `:848` (pass-through) and `:970-971`.
  Ready-to-complete is tickets-only: `web/src/render.ts:836-839`
  `const ready = !done && counted && sp.progress.closed >= sp.progress.total`, with `counted` from
  `sp.progress.total`.
  Covering tests: `test/sprints.routes.test.ts:58` ("is the ticket counts, verbatim"), `:62` ("takes no
  cache input at all"), `:70` ("neither — 0/0"), and the four route cases `:92` tickets only, `:107`
  issues only (progress 0/0, issues 2/3), `:118` both stay separate, `:136` neither (issues null),
  `:145` `GET /sprints/:id` same split; `test/render.roadmap.test.ts:140` (spotlight is the ONE place
  the counts appear), `:155`/`:165` (nothing when null / never on Timeline), `:227` ("the ready rule is
  TICKETS only").
  Revert: folded the cache back into the sum in `viewOf` →
  `npx vitest run test/sprints.routes.test.ts test/roadmap.test.ts test/mcp.tickets.test.ts test/plan.test.ts`
  → `Test Files 4 failed | Tests 11 failed | 59 passed`, incl.
  `test/sprints.routes.test.ts > … > issues only: the cache row NEVER enters the bar — progress 0/0, issues 2/3`.
  Restored.

### 6. Sprint membership of sub-tickets
- **First pass:** no constraint and no cascade — `set_ticket_sprint` updates only the addressed
  ticket; `set_ticket_parent` never touches `sprint_id`; the schema has no trigger. `get_sprint`
  renders a child whose parent is outside the sprint as a root (`depth: 0`), covered by
  `test/sprints.routes.test.ts` ("child whose parent is in another sprint renders as root").
- **Spec:** the same.
- **Action:** none; the verifier re-runs that test and confirms no cascade in the diff or the schema.
- **Verifier result:** PASS — `src/tools/tickets.ts:187-192` (`set_ticket_sprint`) issues exactly one
  `UPDATE tickets SET sprint_id = ?, updated_at = ? WHERE id = ?` on the addressed row;
  `set_ticket_parent` (`:203-222`) contains no `sprint_id` at all — `grep -n sprint_id
  src/tools/tickets.ts` inside that function is empty, its only writes are `parent_id` and the
  parent's `touch`. No DB constraint either: the only triggers on `tickets` are
  `tickets_fts_ai/au/ad` (`migrations/0024_tickets.sql:127-143`), all three touching only
  `ticket_id/title/body`; `:69` is a plain index on `sprint_id`, and `:62` documents it as a soft ref.
  Covering tests `test/sprints.routes.test.ts:244-295` ("sprint membership NEVER cascades…",
  "linking a child NEVER pulls it into its parent's sprint, and no DB trigger does it either" — with a
  `sqlite_master` assertion that no trigger on `tickets` mentions `sprint_id`) plus the pre-existing
  outside-parent-is-root case (child renders at `depth: 0`), all green in the full run.
  Revert: added `UPDATE tickets SET sprint_id = ?, updated_at = ? WHERE parent_id = ?` to
  `set_ticket_sprint` → `npx vitest run test/sprints.routes.test.ts -t "cascade"` →
  `AssertionError: the child does not follow its parent: expected 2 to be 1`. Restored.

### 7. Stale copy
- **First pass:** user-facing "milestone" strings remain: the Guide's My Work paragraph
  (`web/src/render.ts` ~1148–1149: "Two lists … its milestone"), the Guide's Roadmap sentence
  (~1152–1153: "closed/total issue counts recomputed from GitHub events … the issues behind it"),
  the To-do card row label "Milestone" (~1478), the my_work email row label "Milestone"
  (`src/notifications/renderers/my-work.ts:41`) and its sample (`src/notifications/sample.ts:17`),
  and the Maintenance roadmap digest description "Sprints added, changed, reordered, or confirmed
  done." (`src/notifications/renderers/roadmap-plan.ts:88`).
- **Spec:** Guide Roadmap sentence uses the sprint wording; Maintenance roadmap digest description
  reads exactly "Sprint progress and slips."; no user-facing "milestone" string anywhere.
- **Action:** rewrite the Guide's My Work paragraph (three lists, "its sprint") and Roadmap sentence
  (progress from the sprint's tickets; the Narrative tab still links the GitHub issues behind a
  sprint); set the `roadmap_plan` description to "Sprint progress and slips."; relabel the To-do
  card / email / sample row from "Milestone" to "Sprint" — `MyWorkTodo.milestone` becomes
  `MyWorkTodo.sprint: { title, dueOn } | null`, resolved in `getMyWork` from the issue's GitHub
  group number to the sprint whose `github_ref` is that number (falling back to the GitHub title
  when no sprint claims it). Update tests that assert the old label.
- **Verifier result:** PASS — Guide My Work paragraph `web/src/render.ts:1158-1159`: "Three lists:
  To-Do … (each with a one-line summary, its sprint, and a suggested next step); Previous activity …;
  and Tickets assigned to me …" — three lists, no "milestone". Guide Roadmap sentence `:1162-1163`:
  "Each sprint's progress comes from its **tickets** — done plus declined, over the total in that
  sprint — … the **Narrative** tab still links the GitHub issues behind a sprint."
  `src/notifications/renderers/roadmap-plan.ts:88`: `description: "Sprint progress and slips."`
  (exact string). Row label "Sprint": To-do card `web/src/render.ts:1485-1488`, my_work email
  `src/notifications/renderers/my-work.ts:35-42`, sample `src/notifications/sample.ts:14,17,55`.
  `MyWorkTodo.sprint` (`shared/dashboard.ts:29-32`) is resolved in `listOpenAssignedIssues`
  (`src/tools/mywork.ts:129,136-137,145-151`) — `sprintTitlesByGroupNumber` (`:64-84`) maps a bare
  numeric `github_ref` to the sprint title in ONE query, and `sprint:` is `claimed ? {claimed, due_on}
  : group?.title ? {group.title, due_on} : null`, so BOTH branches exist. Because it lives in
  `listOpenAssignedIssues` (the single `MyWorkTodo` builder that `getMyWork` and the my_work renderer
  share) the dashboard and the email cannot disagree — the implementer's flagged judgment call, and it
  is the right seam.
  Covering tests: `test/mywork.test.ts:288` ("resolves the issue's GitHub group number to the SPRINT
  whose github_ref is that number") and `:305` ("an ARRAY github_ref claims no group number — the
  GitHub title is the fallback") — both branches; `test/render.mywork.test.ts:249-262` ("Sprint" row,
  "Milestone" absent); `test/notifications.cards.test.ts:75-83`; `test/notifications.registry.test.ts:48-55`
  (pins the description verbatim + no registry label/description matches `/milestone/i`);
  `test/render.mywork.test.ts:534-562` (guide: three lists, ticket-progress sentence, and
  `expect(render(guideState())).not.toMatch(/milestone/i)`).
  `grep -rn -i milestone web/src src/notifications` → exactly ONE hit:
  `web/src/render.ts:341` — the `href` path segment `${REPO_URL}/milestone/${p}` on a GitHub link
  (the chip KIND is `"group"`, the visible label is `#<n>`), annotated `// The path segment is
  GitHub's own — not Canopy vocabulary.` at `:340`. No rendered text anywhere in either tree.
  Revert: stubbed `claimed` to `null` in `listOpenAssignedIssues` → `npx vitest run test/mywork.test.ts`
  → `AssertionError: expected { …(2) } to deeply equal { title: 'Sprint 12', …(1) }`,
  `1 failed | 18 passed`. Restored.

### 8. Ticket ids
- **First pass:** the My Work ticket card shows a `#<id>` pill (`web/src/render.ts` ~1514); the
  queue rows, the detail header, the sprint-screen rows, and the ticketq email items show no id
  (verify the email — the Phase 6 verifier noted the id may appear as plain text).
- **Spec:** no numeric id shown in any ticket row or header.
- **Action:** remove the pill from the My Work ticket card (the card title becomes the open control)
  and any id text in the ticketq email/sample; update the render test that asserted the pill.
- **Verifier result:** PASS — `grep -n '#\${' web/src/tickets.ts web/src/sprints.ts
  src/notifications/renderers/ticket-queue.ts src/notifications/sample.ts` returns NOTHING; a grep for
  `${t.id}` / `${ticket.id}` outside `data-arg=` in `web/src/tickets.ts` and `web/src/sprints.ts` is
  also empty (queue rows, detail header and sprint rows carry no id). Ticket card
  `web/src/render.ts:1523-1526`: the `cnpy-numpill` `#<id>` span is gone and the TITLE is now the
  `<button data-act="openTicket" data-arg="${t.id}">` (the id survives only as the navigation argument,
  never as text), with the reasoning documented at `:1500-1510`. The one remaining `cnpy-numpill`
  (`web/src/render.ts:1423`) is the To-do card's GitHub ISSUE number — a real external reference,
  correctly kept. Email: `src/notifications/renderers/ticket-queue.ts:90,98,116,123` — `#${t.id}` gone
  from both HTML footers and both text-ledger lines; `src/notifications/sample.ts:26-38,93-96` — the
  two ticketq helpers no longer take an `n`.
  Covering tests `test/render.mywork.test.ts:428-443` ("makes the TITLE the open control and shows NO
  numeric id anywhere" — regex-pins the title inside the `openTicket` button and asserts `#12`,
  `cnpy-numpill` and `/>#\d/` all absent) and `test/notifications.ticketq.test.ts:115-152`.
  Revert: put `#${t.id}` back into the card title → `npx vitest run test/render.mywork.test.ts` →
  `AssertionError: expected '<div class="cnpy-card" style="border:…' not to contain '#12'`,
  `1 failed | 52 passed`. Restored.

## Confirmations from the corrected spec

### `grep -ri milestone src shared web test` is empty
- **State at `3c9aa9e`:** not empty. Remaining hits fall in three groups: (a) Canopy-owned
  identifiers/labels not yet renamed — `MyWorkTodo.milestone`, the "Milestone" row labels, comments
  in `shared/rows.ts` / `shared/sprints.ts` / `src/auth/persons.ts` / `web/src/github.ts` /
  `src/tools/progress.ts`, test names and helper fields (`test/mywork.test.ts`,
  `test/render.mywork.test.ts`, `test/notifications.cards.test.ts`, `test/progress.test.ts`,
  `test/roadmap.test.ts`, `test/sprints.schema.test.ts`, `test/render.sprints.test.ts`,
  `test/tickets.contract.test.ts`, `test/webhook.test.ts`); (b) the literal GitHub JSON key
  `milestone` on issue/PR payloads (`src/webhook.ts`, `src/tools/backfill.ts`, `src/tools/mywork.ts`,
  test fixtures + test payload literals) and the GitHub REST path `/milestones/:n`
  (`src/tools/progress.ts:53`) and the `milestoned`/`demilestoned` webhook action names
  (`src/webhook.ts:108-109`); (c) the design-copied resource fixture `GITHUB · MILESTONE` in
  `test/render.sprints.test.ts` and the `github.com/.../milestone/4` url in link-parser tests.
- **Action:** rename everything in group (a) (identifiers → `group`/`sprint`, comments, test names,
  helper fields). Group (b) is GitHub's own JSON key and REST path: they are kept, each with a
  one-line comment, because renaming them would break payload parsing. Group (c) is test input
  data (a GitHub url is a GitHub url); the resource fixture label is changed to a plain
  `GITHUB` meta. The verifier records the exact residual grep.
- **Verifier result:** PASS (with the flagged deviation accepted) — `grep -rn -i milestone src shared
  web/src test` returns **93 lines**, every one of which classifies. `grep -rn
  "GhMilestone\|milestoneNumber\|GhMilestoneLite" src shared web/src test` → empty; `shared/`,
  `src/tools/plan.ts`, `src/tools/sprints.ts`, `src/tools/tickets.ts`, `src/mcp.ts`,
  `src/notifications/` and `web/src/*` except the one url below carry ZERO hits. The full residual,
  by class:

  **(a) GitHub's own JSON key `milestone` on a payload or our mirrored raw snapshot** — annotated at
  the site or at the declaring type: `src/webhook.ts:56` (`GhGroup` doc: "GitHub's issue GROUP object
  (its own `milestone` payload key)"), `:76`, `:89`, `:140` (comment at `:139`), `:198`, `:200`,
  `:201`, `:202`, `:203`, `:204` (comment at `:197`), `:238`; `src/tools/mywork.ts:59` (block comment
  at `:57-58`), `:136`; `src/tools/backfill.ts:62` (`GhGroupLite` doc), `:79`, `:93`, `:122`, `:123`
  (comment at `:121`), `:146`, `:148`, `:149`, `:150`, `:151`, `:152` (comment at `:145`).
  Test payload literals, each annotated at the site or at the builder that emits it:
  `test/progress.test.ts:68`; `test/dashboard-route.test.ts:34`, `:59`; `test/webhook.test.ts:140`,
  `:141`, `:142`, `:173`, `:174`, `:195`, `:196`; `test/notifications.run.test.ts:40` (comment at
  `:39`); `test/backfill.test.ts:52`, `:63`, `:75`, `:87`, `:99`, `:113`; `test/mcp.mywork.test.ts:29`,
  `:54`; `test/notifications.render.test.ts:49`, `:52`; `test/notifications.cards.test.ts:30`, `:31`,
  `:34`, `:77`, `:78`; `test/identity-routes.test.ts:36`, `:38`; `test/mywork.test.ts:31`, `:57`,
  `:59`, `:60`, `:72`, `:268`, `:295`, `:311`, `:324`.

  **(b) GitHub's own REST path / web url** — `src/tools/progress.ts:51` (`/repos/…/milestones/:n`,
  comment at `:50`); `test/progress.test.ts:130` (inline comment); `test/roadmap.test.ts:56`, `:57`
  (comment at `:56`); `web/src/render.ts:341` (the `href` path segment; the chip KIND is `"group"`,
  comment at `:340`); `test/tickets.contract.test.ts:129`, `:130`, `:132` (a github.com url as
  link-parser INPUT); `test/render.sprints.test.ts:89`, `:435` (the same url as fixture input).

  **(c) GitHub webhook action names** — `src/webhook.ts:110`, `:111` (`"milestoned"` /
  `"demilestoned"`, comment at `:109`).

  **(d) `gh-*.json` fixtures** — GitHub payloads captured verbatim; JSON carries no comments, so these
  are annotated only by their filename/loader: `test/fixtures/gh-issue-assigned.json:6`, `:14`;
  `test/fixtures/gh-issue-closed.json:5`, `:13`; `test/fixtures/gh-pr-merged.json:6`, `:14`.

  **(e) Retired-name literals INSIDE negative assertions** — each annotated `RETIRED NAME/PATHS,
  asserted absent`: `test/sprints.schema.test.ts:81` (`idx_milestones_target_date`), `:127`
  (`milestone:` fts-ref prefix), `:152` (`milestone_proposals`), `:161`, `:162`, `:163`, `:164` (the
  four retired routes). This is the implementer's second flagged judgment call, and it is correct:
  the literal IS the assertion — deleting it would gut the proof that the old surface is gone.

  **(f) Assertions/test names that contain the word in order to prove it is gone** —
  `test/notifications.cards.test.ts:83` (`not.toContain("Milestone")`);
  `test/notifications.registry.test.ts:55` (`!/milestone/i` over every registry label + description);
  `test/render.mywork.test.ts:252`, `:541` (test name "…never its milestone"), `:560`, `:561`
  (`not.toMatch(/milestone/i)`); `test/render.sprints.test.ts:430` (`not.toContain("MILESTONE")`).

  Nothing falls outside (a)–(f), and no residual hit is user-facing text.

### milestone_proposals, its routes, propose_milestone, the Review block, their tests are gone
- **State:** gone in `0025` (`DROP TABLE milestone_proposals`) and Phase 1b; `test/sprints.schema.test.ts`
  asserts the table is absent from `sqlite_master` and that the old routes 404; no `propose_milestone`
  tool; the Review surface lists only doc proposals and ADR drafts.
- **Verifier result:** PASS — `migrations/0025_sprints.sql:126` `DROP TABLE IF EXISTS
  milestone_proposals;`. `test/sprints.schema.test.ts:150-157` asserts the table is absent from
  `sqlite_master`, and `:159-172` drives the four retired routes through the real Hono app with a live
  session cookie, asserting `[404, 405]` for `GET /milestone-proposals`, `POST
  /milestone-proposals/1/promote`, `POST /milestone-proposals/1/reject`, `POST
  /milestones/1/complete`. No `propose_milestone` tool anywhere (`grep -rn propose_milestone src
  shared web/src test` → empty), and `src/mcp.ts` registers no sprint writer. Both cases green in the
  full run.

### `sprints` is the renamed `milestones` table
- **State:** `0025_sprints.sql` uses `ALTER TABLE milestones RENAME TO sprints`; no parallel table,
  no row copy; `test/sprints.schema.test.ts` reads a legacy-shaped row back as a sprint and checks
  `PRAGMA foreign_key_list(sprint_progress)` → `sprints`. The local dev D1 (pre-existing data) took
  the migration cleanly during the first run. No corrective migration needed.
- **Verifier result:** PASS — `migrations/0025_sprints.sql:47` is `ALTER TABLE milestones RENAME TO
  sprints;`. `grep -n "CREATE TABLE\|INSERT INTO" migrations/0025_sprints.sql` shows the only new table
  is `sprint_resources` (`:112`) and the only INSERTs are `roadmap_fts` re-keying (`:78`, `:86`,
  `:101`) — no parallel sprints table, no row copy. The rest of the file is in-place ALTERs
  (`milestone_progress → sprint_progress` `:53`, `milestone_id → sprint_id` `:54`,
  `plan_versions.milestones_json → sprints_json` `:60`, five ADD COLUMNs `:66-70`).
  `test/sprints.schema.test.ts:27` seeds a LEGACY-shaped row and `:85-90` reads it back as a sprint
  through `toSprintView`; `:96` asserts `PRAGMA foreign_key_list(sprint_progress)` points at
  `sprints`. `git diff --stat 5cf3941..e47389d -- migrations` is empty, so this follow-up did not
  touch it.

### ticketq is in the Maintenance policy rows and the Settings cadence rows
- **State:** registered fourth in `src/notifications/registry.ts`; `GET /api/notifications/policy`
  lists it and `GET /api/notifications/prefs` shows it (tests in `test/notifications.ticketq.test.ts`
  and `test/render.notifications.test.ts`).
- **Verifier result:** PASS — `test/notifications.ticketq.test.ts:81` pins
  `REGISTRY.map(k => k.id)` to `["my_work","review_queue","roadmap_plan","ticketq"]`; `:94-101` asserts
  `seedPolicy` inserts `ticketq` into `notification_policy` with its registry defaults; `:269-283`
  `GET /api/notifications/policy` lists it; `:285-309` disabling it org-wide removes it from
  `GET /api/notifications/prefs` and from the next run's kinds (row → `skipped`); `:248-266` a user
  pref of `weekly` moves it between runs. Settings rows: `test/render.notifications.test.ts:77-98`
  asserts the prefs view renders `data-act="setKindCadence" data-arg="ticketq:daily"` and
  `…="ticketq:weekly"`. All green in the full run.

### MCP has list_tickets, get_ticket, list_sprints, get_sprint and no write tools
- **State:** `src/mcp.ts` registers exactly those four; `test/mcp.tickets.test.ts` asserts the
  `tools/list` equality and the explicit absence of every ticket/sprint writer.
- **Verifier result:** PASS — `test/mcp.tickets.test.ts:161-167` reads the LIVE `tools/list` off a
  built `McpServer`, asserts every name in `READ_TOOLS` is present, every name in
  `BANNED_WRITE_TOOLS` is absent, and then the equality
  `names.filter(n => /ticket|sprint/.test(n)).sort()).toEqual([...READ_TOOLS].sort())` — i.e. exactly
  `get_sprint`, `get_ticket`, `list_sprints`, `list_tickets` and nothing else. `:170-176` repeats the
  equality for a non-admin and for an admin principal (no extra tools either way), and `:178-181`
  asserts every description matches `/read-only/i`. Green in the full run.

### No consume() path, proposal, or staging touches tickets or sprints
- **State:** `src/tools/tickets.ts` / `src/tools/sprints.ts` / `src/tools/plan.ts` are direct
  authored writes; no gate call, no `doc_versions`-style staging, no proposals; `consumer.ts`,
  `webhook.ts`, `progress.ts` never reference tickets.
- **Verifier result:** PASS — `grep -n "consume\|ingest\|staged\|doc_versions\|needs_triage\|proposal"
  src/tools/tickets.ts src/tools/sprints.ts src/tools/plan.ts` returns only four COMMENT lines stating
  the absence: `src/tools/tickets.ts:3,5` ("Nothing here goes through `consume()` / the ingestion
  gate…"), `src/tools/sprints.ts:6` (same), `src/tools/plan.ts:43` ("ADMIN direct write
  (promote-class, like promote_doc — NOT the ingestion gate)"). No call site, no staged row, no
  proposal table. `grep -n -i ticket src/consumer.ts` → empty. This matches CLAUDE.md's core
  invariant: ticket/sprint/plan writes are authored, promote-class and direct.

## Verifier run

Independent verification of `5cf3941..e47389d` (nine commits, one per item + the rename residue).
Run on the working tree at `e47389d` with no uncommitted changes; every scratch revert below was
restored with `git checkout -- <file>` and the tree re-checked clean afterwards.

**`npm run check`** — exit 0:

```
> canopy@0.1.0 check
> npm run typecheck && npm run build:web
> tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
> vite build --config web/vite.config.ts
vite v6.4.3 building for production...
✓ 26 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.39 kB
dist/assets/index-moAs7XmT.css   13.67 kB │ gzip:  3.51 kB
dist/assets/index-D12_ehrq.js   304.89 kB │ gzip: 83.58 kB
✓ built in 658ms
```

**`npm test`** — exit 1, the single accepted environmental failure:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
       GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws,
       never hits the network)
AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality

Expected: "excerpt"
Received: "gemini-2.5-flash-lite"

 ❯ test/summarize.test.ts:197:27

 Test Files  1 failed | 91 passed (92)
      Tests  1 failed | 984 passed (985)
   Duration  60.99s
```

That is exactly the failure CLAUDE.md › Conventions & gotchas documents as environmental (a real
`GEMINI_API_KEY` in the local `.dev.vars` leaks into the vitest pool). It is not a regression and not
caused by this follow-up. **984/985 passing, 91/92 files.**

**Working tree** — `git status --porcelain`:

```
?? canopy-tickets-delta.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
```

Only this delta doc and the three pre-existing untracked plan docs. Nothing modified, nothing staged.

**Paths that must not have moved** —
`git diff --stat 5cf3941..e47389d -- migrations docs "Canopy Frontend Design System" .claude
canopy-tickets-audit.md` produces **no output**: the migrations, the design HTML, the skills and the
audit doc are untouched across the whole follow-up.

**Verdict: ACCEPT.** All eight items and all six confirmations PASS. Two deliberate deviations, both
flagged by the implementer and both correct on review: item 7's resolution lives in
`listOpenAssignedIssues` (so the dashboard and the my_work digest share one builder and cannot
disagree), and the retired-name literals inside the negative assertions in
`test/sprints.schema.test.ts` are kept because the literal IS the assertion.

## Step 4 — final check and design-frame walk

Run at HEAD `e47389d` (after the verifier's own run), 2026-09-16:

```
$ npm run check      (tsc worker + web, vite build)
✓ built in 792ms
CHECK EXIT 0
$ npm test
Test Files  1 failed | 91 passed (92)
     Tests  1 failed | 984 passed (985)
```
The one failure is `test/summarize.test.ts` › "GEMINI_API_KEY unset in tests → excerpt" — a real key in
the local `.dev.vars` leaks into the vitest pool (documented in CLAUDE.md); identical at the base commit.

**Design frames 1–6 against the running SPA** (`npm run db:migrate:local` → 0024 + 0025 applied on the
existing local D1, `npm run seed`, `wrangler dev` on :8787, signed in as `DEV_LOGIN`; screenshots taken in
Chrome at each hash route):

| Frame | Route | Result | Gaps |
|---|---|---|---|
| 1 Queue | `#tickets` | Grouped by sprint with ACTIVE, BACKLOG last, needs-attention rule on unassigned submitted rows, badge 2, footer "5 shown · 2 unassigned", Table/Board toggle, Submit a ticket. No ticket ids. | Rows render requester/assignee **handles** for a moment before the persons directory loads, then rerender with names (transient on a cold load; the design always shows names). |
| 2 New ticket | `#tickets/new` | Title (only required, placeholder verbatim), category chips (none = other), priority Normal, description placeholder verbatim, sprint chips Backlog default, assignee chips Unassigned default (multi), link field placeholder verbatim, Submit inert until title. | none |
| 3 Detail | `#tickets/3` | Breadcrumb, title/requester/opened, description, GitHub + Figma chips with meta, "Linked to engineering work" line, sub-ticket relation, sprint rail, assignee list, Done / Back to submitted only, ONE thread: comments and events interleaved — "opened this ticket", "Submitted → In progress", @mention chip, Comment inert until text. | Button reads **Comment** (design) where the spec says "Post". Kept the design's label. |
| 4 My Work | `#mywork` | To-do cards carry the "Sprint" row (resolved from the issue's GitHub group → sprint); third block "Tickets assigned to me" with the To-do card treatment, **no `#id` pill** (title opens the ticket), Summary / Requester / Sprint rows, status + priority footer. | none |
| 5 Maintenance | `#maintenance` | Notifications › Policy lists four kinds incl. **Ticket queue** (Daily) and "Roadmap plan changes — **Sprint progress and slips.**"; Unplaced / Identity / People sections unchanged. | Policy row labels are the email build's ("My Work", "Review queue", "Roadmap plan changes"), not the design's "… digest" wording — pre-existing, outside this spec (which fixes the description only). |
| 6 Settings | `#settings` | Email notifications rows: My Work, Review queue, Roadmap plan changes ("Sprint progress and slips."), **Ticket queue** — Daily / Weekly / Off, Daily selected, ORG DEFAULT. | none |

Also exercised: a comment posted through the UI landed in D1 (`GET /tickets/3` → 3 comments, `updated_at`
bumped) and the My Work ticket card showed "updated 2m ago" afterwards; the Roadmap Timeline shows sprint
cards with the tickets-only bar ("closed/total done") and the Narrative spotlight shows the GitHub issue
counts separately; `POST /mcp` without a bearer is a bare 401.
