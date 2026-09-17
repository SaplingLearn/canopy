# Canopy tickets — build audit

Branch `feat/tickets`, off `2b1f102` (merge of #43, `main`), built in six phases against
`docs/superpowers/plans/2026-09-16-canopy-tickets.md` and the locked design
`Canopy Frontend Design System/Canopy Tickets.dc.html`. Ten local commits, none pushed:

| Commit | Subject |
|---|---|
| `b36b0ba` | chore(tickets): import the locked Tickets design, add the build brief, exclude the parked worktree from vitest |
| `0d2d2dc` | feat(tickets): schema + shared contract (phase 1a) |
| `e17a0fd` | feat(sprints): rename milestones to sprints, drop milestone proposals (phase 1b) |
| `77e736d` | feat(tickets): ticket routes, search, dev seed (phase 2) |
| `c08a248` | feat(sprints): sprint routes, ticket-inclusive roadmap progress, plan skill (phase 3) |
| `8b33fc6` | feat(mcp): read-only ticket and sprint tools (phase 4) |
| `12b73de` | feat(web): tickets queue, new ticket, ticket detail, sidebar + routing (phase 5a) |
| `34f8e2b` | feat(web): My Work tickets block, roadmap sprint cards + new sprint panel, sprint screen (phase 5b) |
| `0a129e8` | feat(notifications): ticket queue digest kind (phase 6) |
| `3c9aa9e` | fix(tickets): final review fixes — chunked id fan-out, plan write preserves panel fields, backlog fold, NOCASE assignee, docs |

**Numbers.** Baseline at `b36b0ba`: **82 test files, 698 of 699 tests passing**. Final at `3c9aa9e`:
**92 test files, 969 of 970 tests passing**; `npm run typecheck` and `npm run build:web` both exit 0.
The single failure throughout is the environmental `test/summarize.test.ts` ›
"with no explicit summarizer and GEMINI_API_KEY unset in tests, the webhook resolves it to null →
excerpt" — a real key in the local `.dev.vars` leaks into the vitest pool (CLAUDE.md › Conventions &
gotchas). That one failure is the accepted baseline for every section below.

**Vitest exclusion.** `b36b0ba` added `"**/.claude/**"` at `vitest.config.ts:45`; without it the suite
also ran the copy of `test/` inside the parked worktree under `.claude/worktrees/`.

Each section is written by an independent verifier that did not write the code.

## Rulings

Every ruling taken during the build, verbatim from the SDD ledger
(`.superpowers/sdd/2026-09-16-canopy-tickets/progress.md`), in order:

- Ruling: migrations are 0024_tickets / 0025_sprints (0023_persons exists) — brief predates the identity cutover — cost if wrong: file rename only.
- Ruling: person columns store persons.handle, requester FK -> persons(handle); brief said users(github_login), which no longer exists — cost if wrong: none, users is gone.
- Ruling: GitHub's own `milestone` vocabulary (payload keys, REST path, issue milestone on To-do cards) is exempt from the rename; dated docs/specs, migrations, design HTML, parked worktree also exempt — cost if wrong: a follow-up mechanical rename.
- Ruling: sprint status column kept; active derived from in_progress; Done group kept on roadmap — cost if wrong: small UI change.
- Ruling: vitest excludes **/.claude/** so the parked worktree's tests stop running from this checkout — cost if wrong: none.
- Ruling: per-phase local commits on feat/tickets, never pushed — the user asked for a phased build with audit-verifiable diffs.
- Ruling: tickets.sprint_id is a soft INTEGER ref (no FK) — D1 enforces FKs and 0024 precedes 0025's sprints table; Phase 2 validates sprint existence in the route (404) — cost if wrong: a dangling sprint_id if a sprint were ever deleted (no delete path exists).
- Ruling: unknown sprint_id on create → 404; unparseable link on create → 400 (implementer's calls, accepted) — cost if wrong: stricter API than the brief implied.
- Ruling: list_sprints/get_sprint defined in src/tools/sprints.ts and re-exported from reads.ts (§C.12 vs §3) — cost if wrong: an import path.
- Ruling: POST /sprints is session-gated, not admin-gated (design call #1: same screens for everyone; the brief's New sprint panel has no admin gate); lead not validated against persons (matches the plan write) — cost if wrong: add an adminGate + a persons check later.
- Ruling: shared/tickets-core.ts (zod-free vocab + status machine, re-exported by shared/tickets.ts) accepted — keeps zod out of the browser bundle without a second transition table — cost if wrong: one extra module.
- Ruling: New sprint panel lives on the Roadmap (brief is explicit: "Roadmap's New sprint panel"), built from the design's panel markup (design lines 156–197, which the design placed in the queue filter row) — cost if wrong: moving one button/panel.
- Ruling: header button copy "Submit a ticket" and "Back to submitted" (design copy) over the brief's shorthand — cost if wrong: two strings.
- Ruling: My Work block order follows the design (To-do, Previous activity, Tickets assigned to me = third block) — cost if wrong: a one-line move.
- Ruling: shared/sprints-core.ts (zod-free vocab) accepted, same idiom as tickets-core.
- Ruling: write_plan uses a dynamic SET list (omitted = preserve, explicit null = clear) instead of COALESCE — cost if wrong: none, both halves tested.
- Ruling: /sprints/:id/complete stays session-gated (pre-existing route; CLAUDE.md corrected to say so) — cost if wrong: add adminGate later.

## Left for the owner

- **Apply the migrations to prod before merging.** `migrations/0024_tickets.sql` and
  `migrations/0025_sprints.sql` have only ever been applied locally (`npm run db:migrate:local`); per §D
  nothing on this branch touched remote D1. A push to `main` auto-deploys prod via Workers Builds, so
  `npm run db:migrate:remote` must land **first** — 0025 renames `milestones` → `sprints` and drops
  `milestone_proposals`, and the deployed Worker reads only the new names.
- **Push / merge is the owner's call.** Every commit is local; nothing was pushed and nothing deployed.
- **Residual `milestone` grep.** `grep -ri milestone` is not empty: 42 files still match, every one
  exempt under the §C.4 ruling above (GitHub's own vocabulary, migration history, dated docs, the locked
  design, the parked worktree). The file-by-file justification table is in **Phase 1 › Gaps / deviations
  › item 6** below.
- **Parked Minors.** Twelve Minor findings from the final review were deliberately left alone; they are
  listed one line each in **Final review and fix pass › Gaps / deviations**, with the reason for each.

---

## Phase 1 — schema and contract (commits 0d2d2dc, e17a0fd)

### Delivered

**1a — tickets schema (`migrations/0024_tickets.sql`, 146 lines)**
- `migrations/0024_tickets.sql:36-44` — the D1 export caveat, copied forward from `0011_fts_recreate.sql`.
- `migrations/0024_tickets.sql:47-50` — `DROP TRIGGER/TABLE IF EXISTS` teardown first, 0011's shape.
- `migrations/0024_tickets.sql:53-65` — `tickets`: id AUTOINCREMENT, `title` NOT NULL, `body` DEFAULT `''`,
  `category` CHECK `('bug','request','question','access','other')` DEFAULT `'other'` (:57),
  `priority` CHECK `('low','normal','high')` DEFAULT `'normal'` (:58),
  `status` CHECK `('submitted','in_progress','done','declined')` DEFAULT `'submitted'` (:59),
  `requester TEXT NOT NULL REFERENCES persons(handle)` (:60, per §C.2 — no `users` table),
  `parent_id INTEGER REFERENCES tickets(id)` (:61), `sprint_id INTEGER` (:62, see Gaps), timestamps.
- `migrations/0024_tickets.sql:68-70` — `idx_tickets_status_updated` / `_sprint` / `_parent`.
- `migrations/0024_tickets.sql:74-79` — `ticket_assignees(ticket_id, login)` PK `(ticket_id, login)`.
- `migrations/0024_tickets.sql:84-94` — `ticket_links` with `kind` CHECK `('github','figma','plain')`.
- `migrations/0024_tickets.sql:97-104` — `ticket_comments`.
- `migrations/0024_tickets.sql:108-116` — `ticket_events`; `from_status` nullable + CHECKed (:112), `to_status` CHECKed (:113).
- `migrations/0024_tickets.sql:124-125` — `tickets_fts` fts5 `(ticket_id UNINDEXED, title, body, tokenize='porter unicode61')`.
- `migrations/0024_tickets.sql:127-142` — `tickets_fts_ai` / `_au` (**AFTER UPDATE OF title, body**) / `_ad`.
- `migrations/0024_tickets.sql:145-146` — the `INSERT … SELECT` backfill.

**1a — `shared/tickets.ts` (248 lines)**
- `shared/tickets.ts:14-27` — the four const tuples + `z.enum`s (match the 0024 CHECK lists exactly).
- `shared/tickets.ts:31-82` — `TicketRow`, `TicketAssigneeRow`, `TicketLinkRow`, `TicketCommentRow`, `TicketEventRow`.
- `shared/tickets.ts:87-109` — `TicketListItem` (`assignees`, `link_count`, `sub_count`, `sprint_label`),
  `TicketRef`, `TicketDetail` (`links`/`comments`/`events`/`parent`/`children`/`sprint`).
- `shared/tickets.ts:113-136` — `TicketCreate` (title min 1; body `''`; category `other`; priority `normal`;
  assignees `[]`; `sprint_id` nullable optional; `link` optional), `TicketTransition`, `TicketAssigneeToggle`,
  `TicketLinkAdd`, `TicketSprintSet`, `TicketParentSet`, `TicketCommentAdd` (trimmed, min 1).
- `shared/tickets.ts:140-144` — `TicketSeg` (`open|closed|all`), `TicketAssigneeFilter` (`anyone|me|unassigned`).
- `shared/tickets.ts:151-156` — `TICKET_TRANSITIONS` = `{submitted:['in_progress','declined'], in_progress:['done','submitted'], done:[], declined:[]}` — exactly §1a.
- `shared/tickets.ts:158-165` — `canTransition`, `legalMoves` (returns a copy).
- `shared/tickets.ts:167-172` — `TICKET_STATUS_LABEL` = Submitted / In progress / Done / Declined.
- `shared/tickets.ts:175-177` — `isOpenStatus`.
- `shared/tickets.ts:212-248` — `parseTicketLink(raw, repo = 'SaplingLearn/sapling')`. Line-for-line the
  design's `parseLink` (`Canopy Tickets.dc.html:1269-1283`): trim/empty→null (:213-214); bare ref →
  `https://github.com/<repo>/issues/<n>` with `^#` stripped (:219); issues|pull → label `<repo> #<n>`,
  meta `GITHUB · ISSUE` / `GITHUB · PULL REQUEST` (:221-229); other github.com → 40-char path slice with
  `"GitHub"` fallback (:231-238); figma → last segment `split("?")[0]`, `[-_]+`→space, capitalized,
  `"Design file"` fallback (:240-243); else hostname sans `www.`, `"link"` fallback (:245-247). The
  U+00B7 `·` separators are byte-identical to the design.
- `shared/rows.ts:6-9` — type-only re-export of the five ticket row types (keeps zod out of the SPA bundle).
- `scripts/seed/reset.mjs:10-14` — `ticket_events → ticket_comments → ticket_links → ticket_assignees → tickets`,
  at the head of `RESET_STATEMENTS`, i.e. the §D FK-safe order.
- `src/auth/persons.ts:106-109` — `HANDLE_COLUMNS` gains all five ticket columns
  (`tickets.requester`, `ticket_assignees.login`, `ticket_links.created_by`, `ticket_comments.author`,
  `ticket_events.actor`).
- `test/tickets.contract.test.ts:18-35` — the 16 from→to pairs written **literally** (not derived from the
  constant), with an exhaustiveness check at :40-47; `legalMoves` at :54-59; the parser's five shapes plus
  bare/`#`/whitespace/`javascript:` at :87-189; payload schemas at :192-266.
- `test/tickets.schema.test.ts:40-121` — tables, defaults, CHECK vocabularies, PK, `PRAGMA foreign_key_list(tickets)`;
  `:123-179` — FTS insert/update-title/update-body/delete + harness-truncation isolation.

**1b — sprints migration (`migrations/0025_sprints.sql`, 126 lines)**
- `migrations/0025_sprints.sql:41-43` — the three `roadmap_fts_milestone_*` triggers dropped **before** the rename.
- `migrations/0025_sprints.sql:46-48` — `DROP INDEX idx_milestones_target_date`; `ALTER TABLE milestones RENAME TO sprints`;
  `CREATE INDEX idx_sprints_target_date`.
- `migrations/0025_sprints.sql:53-54` — `milestone_progress → sprint_progress`, `milestone_id → sprint_id`.
- `migrations/0025_sprints.sql:60` — `plan_versions.milestones_json → sprints_json`.
- `migrations/0025_sprints.sql:66-70` — `dates`, `summary`, `urgency NOT NULL DEFAULT 'normal' CHECK (low|normal|high)`,
  `lead`, `domain CHECK (notifications|tickets|gate|feed|search|infra)`. `phase` correctly **not** re-added (0012 has it).
- `migrations/0025_sprints.sql:76-94` — `roadmap_fts_sprint_ai` / `_au` (**AFTER UPDATE OF title, description,
  summary, phase, status**) / `_ad`, ref `'sprint:' || id`, body = description ∥ summary ∥ phase ∥ status.
- `migrations/0025_sprints.sql:100-105` — `DELETE … WHERE ref LIKE 'milestone:%'` then the `sprint:` backfill.
- `migrations/0025_sprints.sql:112-120` — `sprint_resources(id, sprint_id → sprints(id), url, kind CHECK, label, meta)` + index.
- `migrations/0025_sprints.sql:126` — `DROP TABLE IF EXISTS milestone_proposals`.

**1b — `shared/sprints.ts` (187 lines)**
- `:28-41` vocab; `:45-73` `SprintRow` / `SprintResourceRow`; `:81-127` `SprintProgress`, `SprintView` (§C.7
  vocabulary: `label`, `due`, derived `active`, `progress`, `members`), `SprintTicketRow`, `SprintResourceView`,
  `SprintDetail`; `:131-148` `SprintCreate` / `SprintActiveSet` / `SprintResourceAdd`; `:155` `sprintActive`;
  `:161-187` `toSprintView` (pct rounded, 0 when total 0; `target_date === ''` → `due: null`).

**1b — the §C.3 removal (verified absent repo-wide)**
- `src/consumer.ts` — `ingestMilestoneProposal` gone; the four surviving gate fns are at `:92`, `:115`, `:191`, `:221`.
- `src/tools/writes.ts:344` — `AssignType = "doc" | "adr" | "feed"`; the three proposal writers and the
  `milestone` assign branch are gone. `complete_sprint` at `:267`.
- `src/tools/reads.ts` — `list_milestone_proposals` gone. `src/routes.ts` — the three
  `/milestone-proposals*` routes gone. `shared/contract.ts` — `MilestoneProposal` gone.
  `web/src/api.ts`, `web/src/triage-map.ts`, `web/src/maintenance.ts`, `fixtures/dev/triage.json`
  (now only key `needs_triage`), `scripts/seed/build.mjs` — all cleared.

**1b — the §C.4 rename**
- `shared/contract.ts:65,76,93` — query type enum `"milestone"` → `"sprint"`.
- `src/mcp.ts:49` — MCP `query` enum; `:156-159` — `update_plan` takes `sprints: [{id?, label, summary?,
  description?, phase?, dates?, due, status, urgency?, lead?, domain?, github_ref?}]`.
- `src/routes.ts:75-76` — `/search` types csv; `:289-294` — `POST /sprints/:id/complete`.
- `src/tools/plan.ts:11-31` — `PlanSprintInput`, `PlanView.sprints: SprintView[]`; `:111,:123` — `write_plan`
  snapshots `sprints_json`; `:144-158` — `get_plan` keeps `ORDER BY target_date ASC, id ASC` and maps through
  `toSprintView` with the cache-only progress (§1b: ticket counts are Phase 3).
- `src/tools/reads.ts:188` `QueryType`; `:343-365` the sprint FTS/browse branch; `:403-406` `sprint:<id>` hydration.
- `src/notifications/renderers/roadmap-plan.ts:19` `diffSprints`; `:70-72` `sprints_json`;
  `:88` description "Sprints added, changed, reordered, or confirmed done."
- `src/auth/persons.ts:102-103` — `HANDLE_COLUMNS` gains `sprints.created_by` + `sprints.lead`,
  loses `milestone_proposals.created_by`.
- `shared/rows.ts:13-16` sprint re-exports; `:208` `SprintProgressRow`; `:240` `plan_versions.sprints_json`.
- `web/src/api.ts:90` `QueryType`; `:127` `PlanView.sprints`; `:248` `completeSprint` → `POST /sprints/:id/complete`.
- `web/src/render.ts:267` `sprintRefChips`; `:694-701` `EnrichedSprint` / `roadmapEnriched(sprints, confirmedSprints)`;
  `:756` `sprintRow`; `:774` `confirmSprint` act; `:911,:914` `SEARCH_TYPE_ICON/LABEL` key `sprint`.
- `plugins/canopy/skills/{canopy,read-plan,update-plan}/SKILL.md` + `canopy/references/querying.md`, `CLAUDE.md`,
  `README.md:36`, `wrangler.toml` — all speak sprints. `.claude/skills/` holds one symlink **per skill**
  into `plugins/canopy/skills/<name>` (not a single directory symlink), so the single edit covers both.

**1b — seed / fixtures**
- `scripts/seed/reset.mjs:19` `sprint_progress`; `:25-26` `sprint_resources` before `sprints`;
  `:47-51` the two Google-only persons — `meilin` (Meilin Zhao, `rose`) and `sanaok` (Sana Okafor, `ochre`),
  each with a single `google` identity and no github identity (both colors are valid `PERSON_COLORS`,
  `shared/rows.ts:93`).
- `fixtures/dev/roadmap.json:6` `"sprints"`; every row carries `summary`/`dates`/`urgency`/`lead`/`domain`;
  `:75` and `:112` add `resources` to two sprints. `scripts/seed/build.mjs:76-95` writes `plan_versions.sprints_json`,
  `sprints` (all 0025 columns), `sprint_progress`, `sprint_resources`.
- `test/auth-persons.test.ts:94`, `test/seed-coverage.test.ts:64-70`, `test/identity-schema.test.ts:49` —
  the person-count assertions now expect six persons and assert meilin/sanaok are google-only.

**1b — tests**
- `test/sprints.schema.test.ts:41-89` — legacy-shaped rows read back through `get_plan` with `active` derived
  (`in_progress`→true, `upcoming`/`done`→false), 0025 columns defaulted, CHECKs enforced;
  `:93-96` — `PRAGMA foreign_key_list(sprint_progress)` asserted to equal exactly `["sprint_id→sprints.id"]`
  (a real assertion, confirmed to bite in revert check C's neighbourhood and by :110-112's FK test);
  `:116-137` — `sprint:<id>` refs present, no `milestone:` refs, update/delete triggers live;
  `:141-161` — `milestone_proposals` absent from `sqlite_master` **and** the four retired routes 404/405;
  `:165-196` — `sprint_resources` + FK-safe truncation.
- `test/query.roadmap.test.ts:37-40` — asserts id `sprint:<id>` and `type === "sprint"`.
- `test/rename-handle.test.ts:103-122` (sprints) and `:123-152` (tickets) — both list the `(table, column)`
  pairs **literally** rather than iterating `HANDLE_COLUMNS`, so dropping an entry goes red (revert check D).

### Commands

```
$ npm test
 Test Files  1 failed | 84 passed (85)
      Tests  1 failed | 740 passed (741)
   Start at  04:59:51
   Duration  28.30s (transform 13.32s, setup 299.24s, import 15.80s, tests 10.39s, environment 9ms)

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
   GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never
   hits the network)
 AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality
 ❯ test/summarize.test.ts:197:27
```
The one failure is the accepted environmental baseline (§D). Net of the phase: +3 test files, +42 tests.

```
$ npm run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics — exit 0)
```

```
$ npm run build:web
vite v6.4.3 building for production...
✓ 21 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.40 kB
dist/assets/index-DGylmM7v.css   13.09 kB │ gzip:  3.39 kB
dist/assets/index-CWb3PkHR.js   240.02 kB │ gzip: 68.42 kB
✓ built in 351ms
```

```
$ grep -rli milestone --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude \
    --exclude-dir=.wrangler --exclude-dir=dist --exclude-dir=migrations \
    --exclude-dir="Canopy Frontend Design System" --exclude-dir=docs . | sort
```
42 files, all §C.4-exempt — the table is under Gaps / deviations. **No Canopy-owned identifier still says
"milestone."**

```
$ git status --porcelain
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
```
(three pre-existing untracked plan files; nothing else dirty after the revert checks were restored)

```
$ git diff --stat b36b0ba..e17a0fd -- migrations docs "Canopy Frontend Design System"
 migrations/0024_tickets.sql | 146 ++++++++++++++++++++++++++++++++++++++++++++
 migrations/0025_sprints.sql | 126 ++++++++++++++++++++++++++++++++++++
 2 files changed, 272 insertions(+)

$ git diff --stat b36b0ba..e17a0fd -- .claude
(empty)
```
`migrations/0001`–`0023`, `docs/`, the design HTML and `.claude/worktrees/` are untouched.

### Revert checks

- **A — the transition table.** `shared/tickets.ts:153` changed from `in_progress: ["done", "submitted"]`
  to `in_progress: ["done"]`. `npx vitest run test/tickets.contract.test.ts` → **2 failed | 16 passed**;
  first failure `test/tickets.contract.test.ts:50:59` — `canTransition(from, to)` for `in_progress → submitted`,
  second `test/tickets.contract.test.ts:56:39` — `expected [ 'done' ] to deeply equal [ 'done', 'submitted' ]`.
  Restored with `git checkout -- shared/tickets.ts` → 18 passed.
- **B — the FTS delete trigger.** `migrations/0024_tickets.sql:141` (`DELETE FROM tickets_fts WHERE ticket_id
  = CAST(old.id AS TEXT);` inside `tickets_fts_ad`) replaced by `SELECT 1;`.
  `npx vitest run test/tickets.schema.test.ts` → **6 failed | 7 passed**; the two direct ones are
  `test/tickets.schema.test.ts:156:30` (AFTER DELETE removes the row — `expected 19 to be 1`, the index
  leaking across tests) and `test/tickets.schema.test.ts:168:30` (the harness truncation cascades —
  `expected 20 to be 1`); `:125:30` ("starts empty every test") failed first with `expected 15 to be +0`.
  Restored with `git checkout -- migrations/0024_tickets.sql` → 13 passed.
- **C — the roadmap_fts ref prefix.** `migrations/0025_sprints.sql:77,79,85,87,93` changed `'sprint:'` back to
  `'milestone:'` in all three sprint triggers. `npx vitest run test/sprints.schema.test.ts test/query.roadmap.test.ts`
  → **5 failed | 13 passed**; `test/sprints.schema.test.ts:119:18` — `expected [ 'milestone:7' ] to include 'sprint:7'`;
  `test/sprints.schema.test.ts:131:36` — `expected [ 'milestone:8' ] to deeply equal [ 'sprint:8' ]`;
  `test/query.roadmap.test.ts:38:17` — `expected undefined to be defined` (the `sprint:<id>` hit is gone),
  plus `:64:87` and `:81:16`. Restored with `git checkout -- migrations/0025_sprints.sql` → 18 passed.
- **D — `HANDLE_COLUMNS` coverage.** `src/auth/persons.ts:108` had `["ticket_assignees", "login"]` removed.
  `npx vitest run test/rename-handle.test.ts` → **1 failed | 9 passed**; `test/rename-handle.test.ts:140:126` —
  `ticket_assignees.login missing from HANDLE_COLUMNS: expected false to be true`. Restored with
  `git checkout -- src/auth/persons.ts` → 10 passed.

### Gaps / deviations

**1. `tickets.sprint_id` is a soft `INTEGER`, not `REFERENCES sprints(id)` — accepted.** §1a said to keep the
forward-reference FK clause. `migrations/0024_tickets.sql:19-34` documents why it cannot stay: D1 enforces
foreign keys on its connections, and SQLite resolves *every* FK of a table when it **prepares** any statement
against it. At 1a time `sprints` did not exist at all (0025 was 1b's file), so with the clause in place the
harness's `beforeEach` `DELETE FROM tickets` failed with `no such table: main.sprints: SQLITE_ERROR` and took
all 43 tests in the phase down with it. Post-1b `sprints` does exist, but SQLite has no
`ALTER TABLE ADD CONSTRAINT`, so adding the FK now needs a full `tickets` rebuild — which 1b deliberately did
not do. The relationship is documented in the migration and the column
comment (`:62`), and `test/tickets.schema.test.ts:94-106` asserts the FK set **positively**
(`["parent_id→tickets.id", "requester→persons.handle"]`) rather than leaving it silent. This matches the soft
reference §C.2 already prescribes for the person-handle columns. **Ruling: accepted** — the brief's premise
(SQLite tolerates the forward reference) is true at CREATE time but false at statement-prepare time, and no
read or write path depends on the constraint. Phase 3 may promote it with a table rebuild; it is not required.

**2. `roadmapEnriched` (`web/src/render.ts:701`) kept its name.** §C.4 lists it among the identifiers to
rename, but the name contains no "milestone"; its signature and return type were renamed
(`sprints: SprintView[]` → `EnrichedSprint[]`). Cosmetic, and it passes the phase's stated final check.

**3. `SprintView.progress` is non-nullable (`0/0` replaces the old `progress: null`)** and `computed_at` /
`source` dropped off the view. That is §C.7's shape, and `web/src/render.ts` treats `total === 0` as the old
null (no bar, never "ready to complete"); `test/render.roadmap.test.ts:192` covers the 0/0 case explicitly.

**4. Deliberate additions to `parseTicketLink` over the design's `parseLink`**, both documented at
`shared/tickets.ts:205-210` and tested at `test/tickets.contract.test.ts:181-188`: a non-http(s) absolute
scheme (`javascript:`, `data:`, `mailto:`) returns `null` instead of being pasted into an issue URL (this
value reaches an `href`; §1a mandates the rejection), and the http(s) sniff is case-insensitive. Every
lowercase input behaves exactly as the design does.

**5. Out of scope by design (later phases), confirmed not started:** no ticket writers/routes/MCP tools, no
`"ticket"` query type, no `fixtures/dev/tickets.json` (Phase 2); no `src/tools/sprints.ts`, sprint routes or
ticket-inclusive progress (Phase 3 — `get_plan` builds `progress` from the `sprint_progress` cache only and
`members` is always `[]`, exactly as §1b specifies); no SPA ticket screens (Phase 5); no `ticketq` kind
(Phase 6). `test/rename-handle.test.ts` still seeds the ticket handle columns with direct INSERTs pending
Phase 2's writers.

**6. Residual `grep -rli milestone` — 42 files, every one §C.4-exempt.**

(Counts are matching **lines**, `grep -c -i milestone <file>`.)

| File(s) | Lines | Justification |
|---|---|---|
| `canopy-spec.md` | 5 | The previous build's spec — §C.4-exempt by name. |
| `CLAUDE.md` | 10 | Prose that necessarily names the old identifier: the migration-history list (0012 created `milestone_progress`), 0025's entry spelling out each rename, the Staged-write paragraph on what was dropped, "Sprints ARE the old milestones, renamed in place by 0025", and one GitHub-milestone-number note. |
| `shared/rows.ts` (`:11`, `:205`), `shared/sprints.ts` (`:5`, `:19`, `:51`), `src/auth/persons.ts:102`, `scripts/seed/reset.mjs:23` | 7 | Comments explaining the rename / the retired queue. Same category. |
| `shared/dashboard.ts:27` | 1 | `MyWorkTodo.milestone` = the GitHub milestone an issue belongs to — §C.4-exempt by name. |
| `src/webhook.ts` (20), `src/tools/backfill.ts` (11), `src/tools/progress.ts` (8), `scripts/backfill-events.mjs` (8), `src/tools/mywork.ts` (4) | 51 | GitHub payload fields (`issue.milestone`, `pr.milestone`, `GhMilestone`, the `milestoned`/`demilestoned` actions), `progressFromIssueEvent`'s `milestoneNumber`, and the GitHub REST path `/repos/:repo/milestones/:n`. Each now carries a comment saying the word is GitHub's. |
| `web/src/render.ts` (10 — `:261-271` chip, `:1049-1050` Get Started copy, `:1336`, `:1370-1379` To-do row), `src/notifications/renderers/my-work.ts` (4), `src/notifications/sample.ts` (2), `web/src/github.ts:2` (1) | 17 | The To-do card's **Milestone** row and the GitHub milestone link chip (`${REPO_URL}/milestone/:n`), on My Work and in the `my_work` email — §C.4-exempt by name. |
| `test/fixtures/gh-issue-assigned.json`, `gh-issue-closed.json`, `gh-pr-merged.json` | 6 | GitHub fixtures — §C.4-exempt by name. |
| `test/mywork.test.ts` (11), `test/render.mywork.test.ts` (10), `test/webhook.test.ts` (10), `test/backfill.test.ts` (6), `test/notifications.cards.test.ts` (5), `test/dashboard-route.test.ts` (2), `test/mcp.mywork.test.ts` (2), `test/identity-routes.test.ts` (1), `test/notifications.render.test.ts` (1), `test/notifications.run.test.ts` (1) | 49 | The same GitHub payload field and To-do Milestone row, asserted. |
| `test/progress.test.ts` (6), `test/roadmap.test.ts` (5) | 11 | The stubbed GitHub `/milestones/:n` endpoint plus comments marking it GitHub's vocabulary and one noting a seeded row is the pre-0025 shape. |
| `test/seed-coverage.test.ts:38-39` (2), `test/render.roadmap.test.ts:192` (1) | 3 | The To-do card's GitHub milestone assertion, and a comment about the old `progress:null` render. |
| `test/sprints.schema.test.ts` | 11 | The §1b-mandated "the old thing is gone" assertions: `milestone_proposals` absent from `sqlite_master` (`:141-146`), `idx_milestones_target_date` absent (`:79`), no `milestone:` refs (`:120`), the four retired routes 404 (`:152-155`). |
| `test/tickets.contract.test.ts:128-131` | 3 | The link parser's "other github.com URL" shape, exercised on `github.com/…/milestone/4`. |
| `plugins/canopy/skills/update-plan/SKILL.md:83`, `scripts/build-prod-seed.mjs:116`, `scripts/seed-prod.sql:143,146` | 4 | "`github_ref` — a GitHub milestone number, or an array of issue numbers." |
| `fixtures/dev/events.json` (16), `fixtures/dev/feed.json:7` (1) | 17 | Captured GitHub payloads (`"milestone": null`, the issue's milestone object) and the demo entry about PR #158 ("issue milestone") — GitHub's own feature. |
| `fixtures/dev/docs.json` (6), `scripts/seed-prod.sql:354,484` (2), `scripts/sapling-content/product-overview.md:98` (1) | 9 | **Sapling's** product vocabulary ("landed in milestone #2", "Achievements — unlocked by milestones") — a different product. |

No defect found in this grep.

---

## Phase 2 — ticket routes (commit 77e736d)

Base `e17a0fd` (phase 1b). Verified independently: the verifier did not write this code and did not
edit product code or tests (four scratch reverts, each restored with `git checkout --` and re-run green).

### Delivered

**`src/tools/tickets.ts` (233 lines, new) — the seven writers, DIRECT authored writes**
- `src/tools/tickets.ts:1-18` — the header states the invariant in the code's own voice: nothing here
  touches `consume()` / the gate, `done`/`declined` are set only because a person asked, every write
  bumps `updated_at`, every person value is a canonical `persons.handle`, and the status machine is
  **not** re-declared (`canTransition` is imported from `shared/tickets.ts:158`).
- `src/tools/tickets.ts:33-40` — `TicketError` (`not_found` / `conflict` / `bad_request`) +
  `TICKET_ERROR_STATUS` = 404 / 409 / 400. Anything that is not a `TicketError` re-throws, so a real
  bug stays a 500 instead of being laundered into a 400.
- `src/tools/tickets.ts:42-69` — the guards: `getTicketRow` (404), `touch` (the `updated_at` bump),
  `requirePerson` (`getPerson`, 400 on unknown — and it returns `p.handle`, so a case variant can never
  store an unrenameable spelling), `requireSprint` (404), `requireParsedLink` (400).
- `src/tools/tickets.ts:80-132` — `create_ticket(db, input, requester)`. `requester` is the function's
  own parameter; `TicketCreate` has no requester field at all, so a client value is unreadable here.
  Validates assignees / sprint / link at `:81-92` **before** the first INSERT (D1 has no transaction —
  a bad input must not leave a half-built ticket), then the row (`:95-107`), the assignees (`:110-112`),
  the **opening `ticket_events` row** `from_status NULL → 'submitted'` (`:115-121`), and the parsed link
  (`:123-129`).
- `src/tools/tickets.ts:139-152` — `transition_ticket`: `canTransition` at `:142` or a 409; the history
  row (`:146-150`) and the status UPDATE (`:151`) are written only after that check passes.
- `src/tools/tickets.ts:159-168` — `toggle_assignee`: `INSERT OR IGNORE` on the `(ticket_id, login)` PK /
  an unconditional `DELETE`, i.e. idempotent by construction; unconditional `touch` at `:167`.
- `src/tools/tickets.ts:171-183` — `add_ticket_link` (shared parser, `created_by` = the actor).
- `src/tools/tickets.ts:186-192` — `set_ticket_sprint` (`null` = backlog; unknown id → 404 at `:188`).
- `src/tools/tickets.ts:202-218` — `set_ticket_parent`, the **four §A rejections** plus the degenerate
  self-parent, each a 409 written before any UPDATE: self (`:205`), parent already has a parent (`:206`),
  child already has a parent (`:207`), child is `done`/`declined` (`:208`), child has children (`:210-211`).
- `src/tools/tickets.ts:220-233` — `add_ticket_comment` (trimmed, min 1 → 400).

**`src/tools/reads.ts` — the queue's read projections + the `ticket` query type**
- `src/tools/reads.ts:185-189` — `SEG_STATUSES`: **open = `['submitted','in_progress']`**, closed =
  `['done','declined']`, all = the four.
- `src/tools/reads.ts:202-270` — `list_tickets`. `ORDER BY t.updated_at DESC, t.id DESC` at `:238`;
  filters at `:207-221` (category, `assignee='me'` bound to `filter.me` — an absent `me` binds `""` and
  matches nothing rather than everyone, `:217-219`; `unassigned` = `NOT EXISTS`); per-row
  `assignees` / `link_count` / `sub_count` / `sprint_label` from four grouped `IN (…)` queries
  (`:244-262`), no N+1; `parent_id` rides along in the `...r` row spread at `:264`.
- `src/tools/reads.ts:272-305` — `get_ticket` → `TicketDetail` (assignees, links, comments, events,
  parent, children, `sprint: {id, label}`).
- `src/tools/reads.ts:307-315` — `ticket_badge`: `status IN ('submitted','in_progress') AND NOT EXISTS
  (… ticket_assignees …)` — unassigned **AND** open, exactly §A.
- `src/tools/reads.ts:329` — `QueryType` gains `"ticket"`; `:396` the default type list gains it.
- `src/tools/reads.ts:512-529` — the `tickets_fts` fan-out branch: `bm25(tickets_fts, 1.0, 5.0, 1.0)`
  at `:516` (title weighted 5, same shape as every other type), browse mode `ORDER BY updated_at DESC,
  id DESC` at `:525-526`.
- `src/tools/reads.ts:564-569` — bulk ticket hydration (one `IN (…)` round-trip).
- `src/tools/reads.ts:648-659` — the `Assembled` branch: id `ticket:<id>`, authority **always `live`**
  (a ticket has no staged state), `updated_by` = the requester.

**`src/routes.ts` — the ten routes, all under `sessionGate`**
- `src/routes.ts:35` — `app.use("*", sessionGate)` is registered at the top of the file; every ticket
  route below inherits it. Proved over the wire, not by inspection: `test/tickets.routes.test.ts:638-666`
  drives all ten without a cookie and asserts 401 on each, then asserts the store is untouched.
- `src/routes.ts:296-317` — the section header + `ticketFail` (maps `TicketError` → 404/409/400, re-throws
  anything else), `ticketId` (non-integer → 400), `ticketDetailResponse` (every write answers
  `{ ok:true, ticket: TicketDetail }` re-read through `get_ticket`).
- `src/routes.ts:320-333` — `POST /tickets`. `create_ticket(…, c.get("principal").handle)` at `:326`.
- `src/routes.ts:335-360` — `GET /tickets`; `seg` defaults `open`, `assignee` defaults `anyone`,
  `category` `''`/`all`/absent = every category, each out-of-vocab value a 400 with `issues`;
  `me: c.get("principal").handle` at `:358`.
- `src/routes.ts:362` — **`GET /tickets/badge`**, with the comment saying why it is here.
- `src/routes.ts:364-372` — `GET /tickets/:id` (**registered after the badge**, verified by
  `grep -n '^app\.\(get\|post\)("/tickets' src/routes.ts`: 320, 335, **362**, 364, 374, 388, 401, 415,
  430, 443).
- `src/routes.ts:374-386` — `POST /tickets/:id/status`; `:388-399` `/assignees`; `:401-413` `/links`;
  `:415-428` `/sprint`; `:430-441` `/parent`; `:443-455` `/comment`.

**Search / contract / web enums**
- `shared/contract.ts:65,76,93` — `"ticket"` in `QueryRequest.types`, `QueryPrimary.type`, `QueryPointer.type`.
- `src/mcp.ts:49` — `"ticket"` in the MCP `query` tool's types enum (the **only** `src/mcp.ts` change).
- `src/routes.ts:84-86` — the `/search` types csv accepts `ticket`.
- `web/src/api.ts:90` — `QueryType` gains `"ticket"`.
- `web/src/render.ts:913,916` — `SEARCH_TYPE_ICON.ticket` (24-viewBox glyph) / `SEARCH_TYPE_LABEL.ticket
  = "Ticket"`; `:958` `searchOpenAttr` → `data-act="openTicket" data-arg="<bare id>"`; `:991` the
  `Tickets` chip.

**Seed**
- `fixtures/dev/tickets.json:1-182` — seven tickets. Requesters are **exactly** `meilin` / `sanaok`
  (the §C.9 non-engineer persons seeded at `scripts/seed/reset.mjs:50-51`); assignees are the four
  engineer handles. Statuses: 2 submitted (both unassigned → badge 2), 3 in_progress, 1 done, 1 declined.
  Ticket 3 carries two links (github + figma) and is the parent of ticket 2; five tickets carry comments;
  every ticket carries its opening event row.
- `scripts/seed/build.mjs:102-145` — the insertion block, FK-safe (after sprints and after the person
  seed), with `parent_id` set in a **second pass** (`:118-120`) so the fixture array's order is irrelevant
  against D1's enforced `tickets(id)` FK.
- `scripts/seed-dev.mjs:26` — `tickets: load("tickets.json")`.
- `test/seed-coverage.test.ts:74-117` — proves it against real Miniflare D1: badge > 0 **and** equal to
  the unassigned-open count (`:91`), open/closed segments populated, requesters are exactly
  `{meilin, sanaok}` (`:88`), a ticket with `link_count === 2` that is also a parent with a child and a
  sprint label (`:94-108`), the opening `from_status: null` row (`:106-107`), and `assignee:'me'`.

**Tests**
- `test/tickets.routes.test.ts:1-667` — 31 cases, every one through `app.request` + `cookieFor`:
  create defaults + opening event + requester = principal (`:53`), a client `requester`/`author` in the
  body **ignored** (`:77-83`), body/category/priority/assignees/sprint/parsed link (`:85`), 400s with
  nothing written (`:116`, `:126`, `:139`); seg/assignee/category filters (`:171`, `:186`, `:204`),
  out-of-vocab → 400 (`:213`), `updated_at DESC` asserted against **pinned timestamps whose ids ascend
  the other way** (`:220-252`) with per-row assignees/link_count/sub_count/sprint_label/parent_id;
  detail DTO both sides of the parent/child relation (`:263`); badge across five state changes (`:302`);
  the transition table over the wire — all 4 legal (`:332`) and all 12 illegal (`:360`, each asserting
  the status did not move **and** the event list is byte-equal to before); assignee toggle on/on/off/off
  → 1,1,0,0 (`:401`); every link shape (`:453`); sprint set/move/unset + unknown → 404 (`:487`, `:505`);
  the four nesting rejections **individually**, each with its own error text and a full
  `SELECT id, parent_id, updated_at` snapshot equality (`:536-589`); comment trimming + author = principal
  (`:603`); the ten-route 401 sweep (`:638`).
- `test/query.fts.test.ts:141-174` — the same term in a ticket **title**, a doc body and a feed body;
  asserts the ticket ranks **first** (so the bm25 title weight of 5 is load-bearing), that
  `include_staged:false` still returns it as `live` (`:161-163`), and that deleting the row removes it
  from both `primary` and `pointers` while the doc survives.
- `test/rename-handle.test.ts:17,66-74` — the five ticket handle columns now seed through the **real**
  writers (`create_ticket` + `add_ticket_comment`), discharging 1a's direct-INSERT placeholder.

**Invariants — verified by grep, not by claim**
- `grep -n "consume\|needs_triage\|staged\|proposal" src/tools/tickets.ts` → only the two header comment
  lines (`:3`, `:5`) saying it does **not** do those things. The same grep over
  `src/tools/reads.ts:176-320` (the ticket read block) → nothing.
- `grep -n -i "ticket" src/mcp.ts` → `:49` (the `query` types enum) and `:156`/`:170` (`update_plan`'s
  prose + its `domain` vocab value). **No ticket write tool, and no ticket read tool either** — Phase 4.
- `grep -n -i "ticket" src/webhook.ts src/tools/progress.ts src/consumer.ts` → **no match**. Nothing
  infers `done` / `declined`.
- `grep -rn "canTransition\|TICKET_TRANSITIONS\|legalMoves" --include="*.ts"` → the table is declared
  once, at `shared/tickets.ts:151-156`, and read at `shared/tickets.ts:159,164`, `src/tools/tickets.ts:142`
  and in the two test files. **No second transition table anywhere.**

### Commands

```
$ npm test
 Test Files  1 failed | 85 passed (86)
      Tests  1 failed | 773 passed (774)
   Start at  05:24:53
   Duration  29.28s (transform 13.26s, setup 319.93s, import 14.38s, tests 12.59s, environment 6ms)

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
   GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never
   hits the network)
 AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality
 ❯ test/summarize.test.ts:197:27
```
The single failure is the accepted environmental baseline (§D / CLAUDE.md › Conventions & gotchas).
Net of the phase: +1 test file, +33 tests (85/741 → 86/774).

```
$ npm run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics — exit 0)
```

```
$ npm run build:web
vite v6.4.3 building for production...
✓ 21 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.39 kB
dist/assets/index-DGylmM7v.css   13.09 kB │ gzip:  3.39 kB
dist/assets/index-DnrjgSXP.js   240.19 kB │ gzip: 68.49 kB
✓ built in 334ms
```

```
$ grep -n '^app\.\(get\|post\)("/tickets' src/routes.ts
320:app.post("/tickets", …      335:app.get("/tickets", …
362:app.get("/tickets/badge", … 364:app.get("/tickets/:id", …
374:/status  388:/assignees  401:/links  415:/sprint  430:/parent  443:/comment
```
The badge is registered two lines before `:id`. (Also proved behaviorally — the implementer's own
in-phase revert moved it below `:id` and `test/tickets.routes.test.ts:302` went red.)

```
$ git diff --stat e17a0fd..77e736d -- migrations docs "Canopy Frontend Design System" .claude
(empty)

$ git status --porcelain
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
```
No migration, doc, design or `.claude` file was touched by this phase; the tree is clean except this
audit and the three pre-existing untracked plan docs (after every revert check was restored).

### Revert checks

- **A — the transition guard.** `src/tools/tickets.ts:142` changed from `if (!canTransition(t.status, to))`
  to `if (false && !canTransition(t.status, to))`. `npx vitest run test/tickets.routes.test.ts` →
  **1 failed | 30 passed (31)**; `test/tickets.routes.test.ts:379:61` —
  `AssertionError: submitted → submitted must be refused: expected 200 to be 409`.
  Restored with `git checkout -- src/tools/tickets.ts` → 31 passed.
- **B — one of the four nesting rejections.** `src/tools/tickets.ts:211` (the child-has-children guard)
  changed to `if (false && (kids?.n ?? 0) > 0)`. → **1 failed | 30 passed (31)**;
  `test/tickets.routes.test.ts:578:70` —
  `AssertionError: a ticket with sub-tickets cannot be nested: expected 200 to be 409`.
  Restored → 31 passed.
- **C — the badge predicate.** `src/tools/reads.ts:312` (`AND NOT EXISTS (SELECT 1 FROM ticket_assignees
  a WHERE a.ticket_id = t.id)`) deleted, so `ticket_badge` counts every open ticket.
  `npx vitest run test/tickets.routes.test.ts test/seed-coverage.test.ts` → **2 failed | 36 passed (38)**;
  `test/tickets.routes.test.ts:313:27` — `expected 4 to be 3`, and
  `test/seed-coverage.test.ts:91:19` — `expected 5 to be 2`. Restored → both green.
- **D — the `tickets_fts` fan-out branch.** `src/tools/reads.ts:512` changed to
  `if (false && types.includes("ticket") && !docsOnly)`. `npx vitest run test/query.fts.test.ts` →
  **1 failed | 8 passed (9)**; `test/query.fts.test.ts:155:42` —
  `AssertionError: expected [ 'doc', 'feed' ] to include 'ticket'`. Restored → 9 passed.
- **E — the bm25 title weight.** `src/tools/reads.ts:516` changed from
  `bm25(tickets_fts, 1.0, 5.0, 1.0)` to `bm25(tickets_fts, 1.0, 1.0, 1.0)`. →
  **1 failed | 8 passed (9)**; `test/query.fts.test.ts:156:31` —
  `AssertionError: expected 'doc' to be 'ticket'`. The weighting is load-bearing, not decorative.
  Restored → 9 passed.

Final restore confirmed: `git status --porcelain` lists only the audit and the three pre-existing
untracked plan docs, and
`npx vitest run test/query.fts.test.ts test/tickets.routes.test.ts test/seed-coverage.test.ts` →
**3 files, 47 tests passed**.

### Gaps / deviations

**1. An unknown `sprint_id` on CREATE is a 404 (implementer decision 4) — accepted.** §2 names the 404
only for `set_ticket_sprint`. `tickets.sprint_id` is a soft `INTEGER` (Phase 1 gap 1: 0024 could not carry
the FK), so the route is the only check that exists; letting `POST /tickets` bypass it would be the one
hole through which a dangling `sprint_id` enters. `src/tools/tickets.ts:90` runs it with the other
pre-INSERT validations, and `test/tickets.routes.test.ts:126-137` asserts the 404 leaves zero rows.
Consistent with the setter; strictly safer than the brief.

**2. A link that parses to `null` is a 400, not a dropped field (implementer decision 5) — accepted.**
`parseTicketLink` returns null only for a blank raw (handled separately) or a non-http(s) scheme —
which 1a added *because* the value reaches an `href`. Swallowing it would tell the filer their link was
saved. `src/tools/tickets.ts:65-69`; asserted at `test/tickets.routes.test.ts:139-146` (create) and
`:473-484` (the link route), both with "nothing stored".

**3. `set_ticket_parent` bumps BOTH rows' `updated_at` (implementer decision 6) — accepted.** The child's
`parent_id` changed and the parent's `sub_count` changed, and the queue renders "N sub" off the parent
row, so the parent moving up the `updated_at DESC` sort is correct rather than incidental.
`src/tools/tickets.ts:215-217`, documented in the function's comment. Not specified either way in §A.

**4. `CLAUDE.md` edited (three additive hunks, not on the §2 deliverable list) — accepted.**
`CLAUDE.md:55` adds `tickets.ts` to the `src/tools/` layout line; `:117-124` adds the "Tickets are the
largest authored-write surface" paragraph to the Core-invariant section (naming the seven writers, the
ten cookie routes, "NEVER MCP tools", the `updated_at` rule, the single `canTransition` table, the 409s,
and the one nesting level); `:129-135` moves the read-side engine from "four types" to "five" and names
`tickets_fts` / `ticket:<id>` / always-`live` plus the three read projections. All three statements in
CLAUDE.md were made *false* by this phase, so the edits are corrections, not scope creep; they are
confined to what changed and the `.claude` / `docs` / `migrations` scope diff is still empty.

**5. `openTicket` renders but does nothing yet (documented, Phase 5).** `web/src/render.ts:958` emits
`data-act="openTicket"` on ticket search cards; there is no dispatch case, and `web/src/main.ts:1142`
is `default: return`, so the button is an inert no-op rather than an error. Called out in the code
comment at `web/src/render.ts:951-953`. It means a human who searches today can *find* a ticket and
cannot *open* it — acceptable only because Phase 5 lands the screens; if Phase 5 slipped, this would be
a dead control in a shipped UI.

**6. Out of scope by design, confirmed not started.** No MCP ticket read tools (`list_tickets` /
`get_ticket` / `list_sprints` / `get_sprint` — Phase 4; the read functions already carry the
`{seg, assignee, category, me}` signature Phase 4 needs, and `me` is resolved by the *caller*, never by
the read function, so the MCP path will not need a second resolution). No `src/tools/sprints.ts`, sprint
routes or ticket-inclusive sprint progress (Phase 3 — the seeded tickets move no roadmap bar yet). No
SPA ticket screens, sidebar nav, badge render or `web/src/tickets.ts` (Phase 5); `web/` gained only the
search plumbing. No `MyWorkTicket` / `DashboardData.tickets` (Phase 5). No `ticketq` notification kind
(Phase 6).

**7. `GET /tickets` is unpaginated** (noted by the implementer). The design has no pagination and the
segment filters are the whole contract; if the org queue ever outgrows one response it is one clamped
`LIMIT` in `list_tickets`. Not a §2 requirement.

**8. Minor: the "open" status set is spelled twice.** `SEG_STATUSES.open` (`src/tools/reads.ts:186`) and
the badge's inline `status IN ('submitted','in_progress')` (`:311`) both encode "open" independently of
`isOpenStatus` in `shared/tickets.ts:175-177`. Both are SQL, so neither could import the predicate
directly; the two are consistent today and revert check C proves the badge's half is asserted. Worth a
comment tying them to `isOpenStatus` if the status vocabulary ever grows. Not a defect.

**Verdict: ACCEPT.** Every §A Phase 2 route exists with the stated semantics, under `sessionGate`, as a
direct authored write; the invariants hold under grep; the suite is green but for the accepted
environmental failure; and five independent reverts each turned a specific assertion red.

---

## Phase 3 — sprint routes and the roadmap (commit c08a248)

Base `77e736d` (phase 2). Verified independently: the verifier did not write this code and did not edit
product code or tests (four scratch reverts, each restored with `git checkout --` and re-run green).

### Delivered

**`src/tools/sprints.ts` (370 lines, new) — the one progress rule, the two reads, the four writers**
- `src/tools/sprints.ts:1-22` — header states the authority in the code's own voice: nothing here
  touches `consume()` / the gate; `status:'done'` is set ONLY by `complete_sprint` or the plan write;
  the two-vocabulary seam (`title`/`target_date` never leave this file); and the progress rule spelled
  out as `total = tickets + cache.total`, `closed = tickets done|declined + cache.closed`, 0/0 when
  neither, no live GitHub at render.
- `src/tools/sprints.ts:47-54` — `SprintError` (`not_found` / `conflict` / `bad_request`) +
  `SPRINT_ERROR_STATUS` (404 / 409 / 400); a non-`SprintError` re-throws and stays a real 500.
- `src/tools/sprints.ts:57` — `CLOSED_TICKET_STATUSES = ["done","declined"]`, the one spelling of
  "a person resolved it" used by every counting query in the file.
- `src/tools/sprints.ts:78-82` — **`sprintProgress({ticketsTotal, ticketsClosed, cache})`** (§C.8).
  Pure: no DB, no clock. `pct = total > 0 ? Math.round(100*closed/total) : 0` — 0/0 yields `pct: 0`,
  never `NaN`. THE progress function; grep confirms no second closed/total computation exists
  (see Commands).
- `src/tools/sprints.ts:85-95` — `ticketCountsBySprint`: one `GROUP BY sprint_id` query for every
  sprint's total/closed; `:102-117` `membersBySprint`: one grouped `DISTINCT` join for every sprint's
  assignees; `:120-129` `sprintMembers` the single-sprint form. No N+1 anywhere.
- `src/tools/sprints.ts:133-136` — `SPRINT_ORDER`: `CASE WHEN target_date IS NULL OR target_date = ''
  THEN 1 ELSE 0 END ASC, target_date ASC, id ASC` — unscheduled LAST, one key shared by every sprint
  list.
- `src/tools/sprints.ts:144-153` — **`list_sprints(db)` → `SprintView[]`**: FOUR queries regardless of
  sprint count (rows, ticket counts, members, progress cache); `:156-170` `viewOf` folds row + counts +
  cache + members through `sprintProgress` into `toSprintView`.
- `src/tools/sprints.ts:173-192` — `requireSprint` (404-shaped throw) and `viewFor` (the single-sprint
  view every writer answers with).
- `src/tools/sprints.ts:210-265` — **`get_sprint(db, id)` → `SprintDetail | null`**. `:223` is the
  outside-parent-is-root rule (`if (t.parent_id !== null && present.has(t.parent_id)) continue`) — a
  child whose parent is NOT in this sprint renders at `depth: 0`; `:225-227` emits each root's in-sprint
  children directly under it at `depth: 1`; base order `updated_at DESC, id DESC` (`:216`).
  `:230-257` resources = `sprint_resources` (id ASC) FIRST, then the sprint's ticket links in the ticket
  display order, deduped by url first-wins (`:254`). Matches the design's `spRoots`/`spTickets`
  (`Canopy Tickets.dc.html:1618-1622`) and `spResources` (`:1624-1626`).
- `src/tools/sprints.ts:282-303` — **`create_sprint`**: `status 'upcoming'` (so `active:false`),
  `phase` = `input.phase ?? 'Unscheduled'`, `target_date` = `input.due ?? ''` (the one unscheduled
  sentinel; `toSprintView` shows it as `due: null`), `github_ref` NULL, `created_by` = the principal.
- `src/tools/sprints.ts:317-325` — **`set_sprint_active`**: writes `status` only — `'in_progress'` or
  `'upcoming'`. `:319` `active:false` on a `done` sprint is a NO-OP (returns the row unchanged);
  `active:true` re-opens a done sprint. It can never write `'done'`.
- `src/tools/sprints.ts:333-340` — `complete_sprint`, moved verbatim from `writes.ts`; the only line in
  the file that writes `status = 'done'` (`:338`).
- `src/tools/sprints.ts:351-370` — **`add_sprint_resource`**: `requireSprint` (404) → `parseTicketLink`
  (400 on null, the SHARED parser) → idempotent insert per (sprint, url) → answers with the full
  `SprintDetail`.

**`src/routes.ts:461-541` — the six sprint routes, all under `app.use("*", sessionGate)` (`:40`)**
- `src/routes.ts:467-470` — `sprintFail`: `SprintError` → its status, anything else re-thrown (real 500).
- `src/routes.ts:473-476` — `sprintId`: a non-integer `:id` is a 400 before any DB touch.
- `src/routes.ts:480-485` — **`POST /sprints`**: `SprintCreate.safeParse` → 400 + issues; author =
  `c.get("principal").handle` (a client-supplied creator is impossible — the body schema has no such field).
- `src/routes.ts:489` — **`GET /sprints`** → `{ sprints: SprintView[] }`, each carrying
  `progress {closed,total,pct}` (tickets + cache) and `members` (distinct assignee handles).
  Registered before `/sprints/:id`.
- `src/routes.ts:491-497` — **`GET /sprints/:id`** → the bare `SprintDetail`; unknown id → 404.
- `src/routes.ts:501-512` — **`POST /sprints/:id/active`** `{active: bool}` → `{ok, sprint}`;
  404 unknown, 400 bad payload.
- `src/routes.ts:517-528` — **`POST /sprints/:id/resources`** `{raw}` → `{ok, sprint: SprintDetail}`.
- `src/routes.ts:532-541` — the pre-existing `POST /sprints/:id/complete` (unchanged this phase).

**One read model — `sprintProgress` is what every roadmap surface uses**
- `src/tools/plan.ts:145-156` — `get_plan` now builds `sprints` from `list_sprints(db)` (`:147`), so
  `progress` is ticket-inclusive and `members` is real. `write_plan` untouched.
- `src/routes.ts:272` `GET /roadmap` → `get_plan`; `src/mcp.ts:121` MCP `get_roadmap` → `get_plan`;
  `src/routes.ts:489` `GET /sprints` → `list_sprints`. All three land on the same function.
- `src/tools/reads.ts:317-323` — `export { list_sprints, get_sprint } from "./sprints"` with a comment
  explaining why the definitions live next to the math (§C.12 reachability without a second copy).
- `src/tools/writes.ts:262-270` — `complete_sprint` is now `export { complete_sprint } from "./sprints"`;
  the old import path still works (`test/roadmap.test.ts` imports it from `writes`).

**Tests (`test/sprints.routes.test.ts`, 469 lines, new — 28 cases)**
- `:57-89` the pure rule, four cases pinning four different numbers (tickets-only 1/4/25, issues-only
  2/3/67, both 4/7/57, neither 0/0/0) plus rounding/100.
- `:93-180` the same four through the live `GET /sprints`, plus "a ticket moved OUT stops counting"
  (`:141`), members dedupe/scoping (`:154`), unscheduled-last ordering (`:171`).
- `:184-271` `GET /sprints/:id`: the ordered `[title, depth]` array including a child whose parent is in
  another sprint (`:212-224`), the url dedupe with both storage rows still present (`:227-250`), and
  detail-vs-list progress/members agreement (`:252`).
- `:275-347` `POST /sprints` (raw row asserted as `{target_date:'', status:'upcoming'}` at `:295`; the
  400 sweep at `:333` also asserts nothing was written), `:351-398` the active toggle incl. the
  done no-op and the re-open, `:402-442` resources incl. idempotency and the 400/404 sweep,
  `:446-469` the 401 sweep over all six surfaces re-asserting stored state.
- `test/roadmap.test.ts:133-158` (`GET /roadmap`) and `:194-224` (MCP `get_roadmap`) each seed a
  LEGACY-shaped row + a 2/3 cache + two tickets and assert `3/5, pct 60` — the cache alone would read
  2/3, so the join is what the assertion pins.
- `test/seed-coverage.test.ts:62-70` the dev seed's sprint 3 reads 3/7 while its cache alone is 2/3;
  `:72-90` the fixture's deliberate shared url (`fixtures/dev/roadmap.json:87-94`) proves the dedupe and
  roots-only ordering off real generated SQL.

**Skills (edited under `plugins/`; `.claude/skills/*` are per-skill symlinks — `ls -la` confirms all six resolve)**
- `plugins/canopy/skills/update-plan/SKILL.md:26-29` — re-homing a ticket is how the bar moves, not an
  `update_plan` call; `:87-92` — "You never write progress", with the ticket + cached-issue rule spelled out.
- `plugins/canopy/skills/read-plan/SKILL.md:33-42` — `progress` is **ticket-inclusive**, `members` is the
  sprint's assignees (and not a staffing claim), unscheduled sorts last; `:57-61` — the hard rule split
  into "the GitHub half is cached, the ticket half is live" and "progress moving ≠ done".
- `plugins/canopy/skills/canopy/SKILL.md:49-66` — `query`'s five types, `get_roadmap`'s
  ticket-inclusive progress + members, and `list_tickets`/`get_ticket`/`list_sprints`/`get_sprint`;
  `:81-86` — "Tickets and sprints are read-only over MCP", ticket/sprint `done` set by a person.
- `plugins/canopy/skills/canopy/references/querying.md:12` — `types` is now
  `doc|decision|feed|sprint|ticket`; `:58-63` — the four read tools in the "which read tool" list.
- `CLAUDE.md:55` (`tools/sprints.ts` in the layout), `:150-161` (the five sprint routes + active/done
  rules under Staged-write), `:223-231` (Progress rewritten to the ticket-inclusive rule).

### Commands

```
$ npm test
 Test Files  1 failed | 86 passed (87)
      Tests  1 failed | 804 passed (805)
   Start at  05:46:31
   Duration  29.30s (transform 12.27s, setup 310.11s, import 13.73s, tests 11.47s, environment 11ms)

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
   GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never
   hits the network)
 AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality
 ❯ test/summarize.test.ts:197:27
```
The single failure is the accepted environmental baseline (§D / CLAUDE.md › Conventions & gotchas), the
same one Phases 1a/1b/2 reported. Net of the phase: +1 test file, +31 tests (86/774 → 87/805).

```
$ npm run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics — exit 0)
```

```
$ npm run build:web
vite v6.4.3 building for production...
✓ 21 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.39 kB
dist/assets/index-DGylmM7v.css   13.09 kB │ gzip:  3.39 kB
dist/assets/index-DnrjgSXP.js   240.19 kB │ gzip: 68.49 kB
✓ built in 336ms
```
Byte-identical to Phase 2 — `web/` was not touched.

```
$ grep -rn "sprintProgress|toSprintView" src shared
src/tools/sprints.ts:78    export function sprintProgress(...)        ← the ONE rule
src/tools/sprints.ts:162   viewOf → sprintProgress(...)               ← the only caller
src/tools/sprints.ts:169   viewOf → toSprintView(row, {closed,total}) ← the one DTO translation
shared/sprints.ts:161      toSprintView (re-derives pct from the SAME closed/total)
src/tools/plan.ts:147      get_plan → list_sprints(db)                ← no second path
src/routes.ts:489          GET /sprints → list_sprints(c.env.DB)
src/tools/reads.ts:323     export { list_sprints, get_sprint } from "./sprints"
```
No second closed/total computation exists. The only other reader of the cache is
`src/tools/progress.ts` (the two WRITERS: webhook + cron) and `src/tools/reads.ts:399`
(`assembleSprintBody`, the search-result prose line — see Gaps 4).

```
$ grep -rn "UPDATE sprints|INSERT INTO sprints" src
src/tools/sprints.ts:286   INSERT … status 'upcoming'        (create_sprint)
src/tools/sprints.ts:322   UPDATE … SET status = ?           (set_sprint_active — 'in_progress'|'upcoming' only, :320)
src/tools/sprints.ts:338   UPDATE … SET status = 'done'      (complete_sprint)
src/tools/plan.ts:69,90    UPDATE/INSERT                     (write_plan — the admin plan write)
```
Sprint `done` is reachable from exactly two places: `complete_sprint` and the admin plan write.

```
$ grep -rn "UPDATE tickets|INSERT INTO tickets" src   (excluding src/tools/tickets.ts)
(empty)
$ grep -rn "ticket" src/webhook.ts src/tools/progress.ts
(empty)
```
Nothing in the webhook or the progress writers so much as mentions a ticket, let alone writes a status.

```
$ git diff 77e736d..c08a248 -- src/mcp.ts
(empty)
```
No MCP write tool was added — `src/mcp.ts` is untouched; `test/roadmap.test.ts`'s "MCP registers NO
sprint write tool" guard still bites.

```
$ git diff --stat 77e736d..c08a248 -- migrations docs "Canopy Frontend Design System" .claude
(empty)

$ git status --porcelain
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
```
No migration, doc, design or `.claude` file was touched; the tree is clean except this audit and the
three pre-existing untracked plan docs (after every revert check was restored).

Baseline for the reverts:
`npx vitest run test/sprints.routes.test.ts test/roadmap.test.ts test/seed-coverage.test.ts test/plan.test.ts`
→ **4 files, 59 tests passed**.

### Revert checks

- **A — the ticket half of the progress rule.** `src/tools/sprints.ts:79-80` changed from
  `ticketsTotal + (cache?.total ?? 0)` / `ticketsClosed + (cache?.closed ?? 0)` to
  `cache?.total ?? 0` / `cache?.closed ?? 0` (cache-only, the pre-Phase-3 behavior).
  → **4 files, 10 failed | 49 passed (59)**. Failing assertions:
  `test/sprints.routes.test.ts:59:67` — `expected { closed: 0, total: 0, pct: 0 } to deeply equal
  { closed: 1, total: 4, pct: 25 }`; `:70:99` — `expected {2,3,67} to deeply equal {4,7,57}`;
  `:83:71`, `:106:59`, `:131:59`, `:147:70`, `:261:29`; plus
  `test/roadmap.test.ts:154:25` and `:219:27` — `expected { closed: 2, total: 3, pct: 67 } to deeply
  equal { closed: 3, total: 5, pct: 60 }` (the HTTP and MCP roadmap paths), and
  `test/seed-coverage.test.ts:68:28` — `expected {2,3,67} to deeply equal {3,7,43}`.
  Restored with `git checkout -- src/tools/sprints.ts` → green.
- **B — the outside-parent-is-root rule.** `src/tools/sprints.ts:223` changed from
  `if (t.parent_id !== null && present.has(t.parent_id)) continue` to `if (t.parent_id !== null) continue`,
  i.e. every child treated as a child regardless of whether its parent is in the sprint.
  `npx vitest run test/sprints.routes.test.ts test/seed-coverage.test.ts` →
  **1 failed | 35 passed (36)**; `test/sprints.routes.test.ts:212:59` —
  `AssertionError: expected [ [ 'Loner', +0 ], …(3) ] to deeply equal [ Array(5) ]` (the outsider's child
  vanishes from the sprint entirely). Restored → 36 passed.
- **C — the resource url dedupe.** `src/tools/sprints.ts:254` (`if (seen.has(r.url)) continue`) deleted.
  → **2 failed | 34 passed (36)**; `test/sprints.routes.test.ts:240:48` —
  `AssertionError: expected [ …(4) ] to deeply equal [ …(3) ]`, and
  `test/seed-coverage.test.ts:82:46` — `expected [ …(2) ] to have a length of 1 but got 2` (the dev
  fixture's shared issue url appears twice). Restored → 36 passed.
- **D — `get_plan` bypassing `list_sprints`.** `src/tools/plan.ts:147` replaced with the Phase-1b
  cache-only body (`SELECT * FROM sprints ORDER BY target_date ASC, id ASC` + `getProgress` +
  `toSprintView(sp, cacheOnly, [])`), the two imports restored to match.
  `npx vitest run test/roadmap.test.ts test/seed-coverage.test.ts test/sprints.routes.test.ts` →
  **3 failed | 46 passed (49)**; `test/roadmap.test.ts:154:25` and `:219:27` —
  `expected { closed: 2, total: 3, pct: 67 } to deeply equal { closed: 3, total: 5, pct: 60 }`, and
  `test/seed-coverage.test.ts:68:28` — `expected {2,3,67} to deeply equal {3,7,43}`. Both the HTTP and
  the MCP roadmap are wired through `list_sprints`, not merely through `sprintProgress`.
  Restored with `git checkout -- src/tools/plan.ts` → 59 passed.
- **E — the unscheduled-last sort key.** `src/tools/sprints.ts:136` reduced to
  `ORDER BY target_date ASC, id ASC`. → **1 failed | 50 passed (51)**;
  `test/sprints.routes.test.ts:178:38` — `AssertionError: expected [ 9, 10, 8 ] to deeply equal
  [ 10, 8, 9 ]`. Restored → green.

Final restore confirmed: `git status --porcelain` lists only the audit and the three pre-existing
untracked plan docs, and
`npx vitest run test/sprints.routes.test.ts test/roadmap.test.ts test/seed-coverage.test.ts test/plan.test.ts`
→ **4 files, 59 tests passed**.

### Gaps / deviations

**1. Sprint reads live in `src/tools/sprints.ts`, re-exported from `reads.ts` (orchestrator ruling — accepted).**
Verified as described: `list_sprints`/`get_sprint` are defined at `src/tools/sprints.ts:144` and `:210`
and re-exported at `src/tools/reads.ts:323`. §3 puts them in `sprints.ts`, §C.12 in `reads.ts`; the
re-export satisfies both without a second copy of the math. No cycle — `sprints.ts` imports
`./progress` and `@shared/*`, never `reads.ts`. Phase 4 can import from either module; if it imports
from `reads.ts` it gets the identical binding.

**2. Unscheduled/blank due dates sort LAST (orchestrator ruling — accepted). This is a behavior change
to `get_plan`'s order.** `src/tools/sprints.ts:136` prepends `CASE WHEN target_date IS NULL OR
target_date = '' THEN 1 ELSE 0 END ASC` to the §1b order `target_date ASC, id ASC`. Because `get_plan`
now goes through `list_sprints`, `GET /roadmap` and MCP `get_roadmap` changed order too — a blank
`target_date` used to sort FIRST (`''` < any date) and now sorts last. Every existing plan/roadmap test
stays green only because all their sprints carry a due date, and revert E showed the ordering is pinned
**only** by `test/sprints.routes.test.ts:171` (through `GET /sprints`) — reverting the key left every
`/roadmap` assertion green. The `get_plan` docstring (`src/tools/plan.ts:136`) does say "unscheduled
last", so the contract is documented; it is simply not asserted on that surface.

**3. `POST /sprints` is session-gated, not admin-gated, and `lead` is not validated against `persons`
(orchestrator ruling — accepted).** Verified: `src/routes.ts:480` sits under the blanket
`app.use("*", sessionGate)` (`:40`) and no `adminGate` touches it — `adminGate` is applied only to
`/invites` (`:238-239`) and inline at `:295`. So any signed-in org member can create a sprint, matching
the design's New sprint panel, which has no admin affordance. `create_sprint`
(`src/tools/sprints.ts:282-303`) stores `input.lead` verbatim with no `persons` lookup and there is no FK
on the column, so a typo'd handle is stored and renders as an unresolvable avatar; this matches
`write_plan` (`src/tools/plan.ts:81`), which does not validate it either — the two paths agree, which is
what matters. Note the asymmetry with tickets, which DO validate (`ticket_assignees.login` is a queue
filter; `sprints.lead` is display metadata).

**4. `query()` / `GET /search` still show cache-only progress for a sprint.**
`src/tools/reads.ts:399` (`assembleSprintBody`) renders `Progress: <closed>/<total> closed` straight
off the `sprint_progress` cache row, so a sprint whose progress is entirely ticket-driven shows no
progress line in a search result while `GET /roadmap` shows the real bar. Not a Phase 3 deliverable
(§3 names `GET /roadmap`, `get_roadmap` and `GET /sprints`, all three of which are correct) and
pre-existing from 1b, but it is now the ONE read surface where "progress" means something different.
One line — passing the ticket counts in, or dropping the line — would close it.

**5. `members` is `login ASC`, not the design's first-appearance order.** The design's `sprStats`
(`Canopy Tickets.dc.html:1574`) builds members by walking the sprint's tickets in seed order;
`src/tools/sprints.ts:98-108` sorts alphabetically. Deliberate (implementer decision 4): alphabetical is
deterministic, so the Roadmap card's avatar row does not reshuffle when a ticket is touched. Everything
else in `sprStats`/`spRoots`/`spTickets`/`spResources` matches the design exactly, with the GitHub cache
half added per §C.8 (the design has no `github_ref`).

**6. `get_sprint` recomputes its own ticket counts from the emitted list.**
`src/tools/sprints.ts:259-262` derives `total`/`closed` from `ordered` rather than from
`ticketCountsBySprint`. It agrees with `list_sprints` for every route-reachable shape, because the route
layer enforces one-level nesting (`set_ticket_parent`). If a two-level chain ever existed in D1 (only
reachable by hand-written SQL), the grandchild would be emitted by neither loop and `get_sprint` would
under-count against `GET /sprints`. Harmless today; worth a `ticketCountsBySprint`-backed count if
nesting depth ever changes.

**7. `POST /sprints/:id/complete` answers 400 where the new routes answer 404/409.**
`src/routes.ts:532-541` (pre-existing, untouched this phase) maps every `complete_sprint` throw —
unknown sprint, already-done — to a flat 400 with the message, while the four new routes in the same
block go through `SprintError` → 404/409 (`:467`). Inconsistent within one block; not a §3 requirement
and no test asserts otherwise.

**8. Response shape differs between the two `SprintDetail` surfaces.** `GET /sprints/:id` (`:491`)
returns the bare `SprintDetail`; `POST /sprints/:id/resources` (`:517`) returns
`{ok, sprint: SprintDetail}`. Both are asserted, so Phase 5's client must handle the two shapes.

**9. The `canopy` skill documents four MCP tools that do not exist yet.**
`plugins/canopy/skills/canopy/SKILL.md:60-66` and `references/querying.md:58-63` describe
`list_tickets` / `get_ticket` / `list_sprints` / `get_sprint` as MCP read tools; Phase 4 registers them
and `src/mcp.ts` is untouched this phase, so an agent reading the skill today would call a tool that
`tools/list` does not carry. Deliberate (so Phase 4 matches the documented names) and the
`allowed-tools` frontmatter (`SKILL.md:4`) was correctly NOT widened — it still lists only
`mcp__canopy__query` and `mcp__canopy__get_doc`. Phase 4 must add the four there.

**10. Out of scope by design, confirmed not started.** No MCP tools at all (Phase 4 —
`git diff … -- src/mcp.ts` empty). No SPA (Phase 5 — `web/` untouched, the build is byte-identical;
`SprintDetail` is populated by the API and nothing paints it). No `GET /sprints` pagination or filter,
no `sprint_resources` delete route (neither is in §A or the design). `scripts/seed/build.mjs` needed no
change — 1b already emits `INSERT INTO sprint_resources`; `npm run seed:dev` was not run (needs a local
wrangler D1), but `test/seed-coverage.test.ts` executes every generated statement against real
Miniflare D1.

**Verdict: ACCEPT.** All six §A Phase 3 routes exist under `sessionGate` with the stated semantics;
`sprintProgress` is provably the only closed/total rule and `GET /roadmap`, MCP `get_roadmap` and
`GET /sprints` all reach it through `list_sprints`; sprint `done` remains reachable only from
`complete_sprint` and the admin plan write, nothing outside `tools/tickets.ts` writes a ticket status,
and no MCP write tool was added; the suite is green but for the accepted environmental failure; and five
independent reverts each turned a specific assertion red.

---

## Phase 4 — MCP read tools (commit 8b33fc6)

Base `c08a248` (phase 3). Verified independently: the verifier did not write this code and did not edit
product code or tests (three scratch reverts, each restored with `git checkout --` and re-run green;
`git status --porcelain` after restore shows only this audit file and the three pre-existing untracked
`docs/superpowers/plans/2026-0[67]-*` docs).

### Delivered

**`src/mcp.ts` — exactly four read tools, for every principal, zero write counterpart**
- `src/mcp.ts:125-132` — the block header states the invariant in the code's own voice: these four are
  the whole ticket/sprint MCP surface, there is deliberately no write counterpart (§A — "MCP gets read
  tools only"), and they are NOT admin-gated.
- `src/mcp.ts:133-144` — **`list_tickets`**. Args `seg` / `assignee` / `category`, each `.optional()`
  and typed from the shared Zod enums (`src/mcp.ts:8` imports `TicketSeg`, `TicketAssigneeFilter`,
  `TicketCategory` from `@shared/tickets`) — no inline re-typing of the vocabulary. `src/mcp.ts:143`:
  `runTool(() => list_tickets(env.DB, { ...args, me: principal.handle }))` — `me` is bound to the
  bearer principal and cannot be supplied by the client.
- `src/mcp.ts:146-156` — **`get_ticket`** (`id: z.number()`); unknown id throws `no such ticket: <id>`,
  which `runTool` converts to `{ error }` + `isError` (§4's requirement).
- `src/mcp.ts:158-163` — **`list_sprints`** (no args).
- `src/mcp.ts:165-175` — **`get_sprint`** (`id: z.number()`); unknown id throws `no such sprint: <id>`.
- All four are registered at `src/mcp.ts:133-175`, i.e. ABOVE the single `if (isAdmin(...))` branch at
  `src/mcp.ts:206` (which still guards only `update_plan`) — so every bearer principal gets all four.
- Full registration list on the surface, in order: `query`, `get_doc`, `list_docs`, `get_feed`,
  `append_feed`, `propose_doc_update`, `get_roadmap`, **`list_tickets`**, **`get_ticket`**,
  **`list_sprints`**, **`get_sprint`**, `get_my_work`, `get_events`, `record_session`, `update_plan`
  (admin-only). Four new, nothing else added.
- **No ticket/sprint writer of any kind appears in `src/mcp.ts`.** All eleven writers exported by
  `src/tools/tickets.ts:80,139,159,171,186,202,220` and `src/tools/sprints.ts:293,328,344,362` were
  grepped by name against `src/mcp.ts`: zero hits (verbatim output under Commands). The only writer on
  the surface is the pre-existing admin-gated `write_plan` (`src/mcp.ts:227`), which §C.7 keeps.
- `/mcp` bearer-only is untouched: `git diff c08a248..8b33fc6 -- src/index.ts` is **empty**.

**The Phase 3 carry-over — the assembled `sprint` body is ticket-inclusive**
- `src/tools/reads.ts:396-420` — `assembleSprintBody(sp, cache, tickets)` now runs BOTH halves through
  `sprintProgress` (`src/tools/reads.ts:413-417`) instead of printing the cache row directly.
  `src/tools/reads.ts:418` is the ONLY `Progress: ` emitter in `src/` (grep under Commands), and
  `sprintProgress` (`src/tools/sprints.ts:78`) remains the only closed/total rule — no second math was
  introduced in `reads.ts` (its `SEG_STATUSES` at `src/tools/reads.ts:188-192` is the `seg` list filter
  from Phase 2, not progress arithmetic).
- `src/tools/sprints.ts:84-106` — `ticketCountsBySprint` is exported and takes an optional `ids` scope;
  `ids: []` short-circuits to an empty Map with no query (`src/tools/sprints.ts:99`). The closed-status
  list stays the single `CLOSED_TICKET_STATUSES` constant (`src/tools/sprints.ts:57`).
- `src/tools/reads.ts:612-614` — one grouped count query over the hydrated sprint ids only (not the
  table); `src/tools/reads.ts:704` is the call site. No import cycle: `sprints.ts` never imports
  `reads.ts`.
- **A sprint with neither tickets nor cache renders NO `Progress:` line** (`src/tools/reads.ts:418`,
  `progress.total > 0`), matching the pre-existing `if (progress)` guard. Confirmed by code and by the
  assertion at `test/query.roadmap.test.ts:134`.

**`test/mcp.tickets.test.ts` (364 lines, new) — 12 cases over `InMemoryTransport`**
- `test/mcp.tickets.test.ts:24` — `READ_TOOLS` (the four); `:28-40` — `BANNED_WRITE_TOOLS`, the eleven
  ticket/sprint writers named **explicitly** (every export of `tools/tickets.ts` + `tools/sprints.ts`).
- `test/mcp.tickets.test.ts:47-59` — `withClient` builds the REAL `buildCanopyMcpServer(env, {handle})`
  per call and drives it over a linked `InMemoryTransport` pair; nothing calls the read functions
  directly, so a missing or renamed registration is a failure, not a green.
- `test/mcp.tickets.test.ts:98-158` — `seedQueue()` builds the fixture through the real Phase 2/3
  writers (`create_sprint` / `create_ticket` / `transition_ticket` / `set_ticket_parent` /
  `add_ticket_link` / `add_ticket_comment` / `add_sprint_resource` / `upsertProgress`), never raw
  INSERTs: two sprints (one active), six tickets across all four statuses and four categories, one
  parent/child pair, one url that is both a ticket link and a sprint resource, one progress cache row.
- `test/mcp.tickets.test.ts:161-167` — **the absence list is asserted explicitly and three ways**:
  every read tool `toContain` (`:163`), every one of the eleven write names `not.toContain` (`:164`),
  and `names.filter(/ticket|sprint/).sort()` **`toEqual`** the four (`:166`) — an equality, so adding a
  fifth ticket/sprint tool reds it too.
- `test/mcp.tickets.test.ts:169-176` — not admin-gated: a second principal (`beatrix`) first proves she
  is non-admin (`update_plan` absent, `:172`), then gets all four; the admin gets no extra one (`:175`).
- `test/mcp.tickets.test.ts:178-186` — the descriptions are contract: `/read-only/i` on all four,
  `/never GitHub issues/i` (ADR-007) and `/human-only|no MCP write path/i`.
- `test/mcp.tickets.test.ts:190-208` — `seg` default `open` excludes done+declined AND `seg:'all'`
  returns all six (`:204`), so the default cannot pass on an empty table; `:206-207` pins `closed`.
- `test/mcp.tickets.test.ts:210-225` — per-row `assignees` / `link_count` / `sub_count` /
  `sprint_label` / `requester`.
- `test/mcp.tickets.test.ts:227-245` — **the two-principal `assignee:'me'` test, and it is real**: two
  servers built for `andres` and `beatrix`, two exact disjoint id sets (`:233-234`), each row verified
  to carry that handle (`:235-236`), the two sets asserted different (`:238`), a third principal with
  nothing assigned getting `[]` rather than everyone's (`:241`), plus `assignee:'unassigned'` (`:244`).
  A constant, a dropped `me`, or a client-supplied value cannot satisfy both sets.
- `test/mcp.tickets.test.ts:247-260` — three exact single-element category results, `seg`+`category`
  composition, and an out-of-vocab `category:'chore'` → `isError` (so widening the enum reds it).
- `test/mcp.tickets.test.ts:264-295` — the whole `TicketDetail`: assignees, link url+kind, comment
  author+body, the opening event `{from_status: null, to_status:'submitted'}`, parent/children from
  both sides, `sprint {id,label}`, and a three-row ordered history.
- `test/mcp.tickets.test.ts:297-304` / `:356-363` — unknown id → `isError` with `{ error }` text
  containing `no such ticket` / `no such sprint`.
- `test/mcp.tickets.test.ts:308-326` — `list_sprints` pins `{closed:2,total:5,pct:40}` where the cache
  alone reads 1/2 and the tickets alone 1/3 (neither half satisfies it), exact `members`, and a second
  tickets-only sprint at 0/1.
- `test/mcp.tickets.test.ts:330-354` — `get_sprint`: the child sits at `tickets[rootIdx+1]` with
  `depth:1` and is the only depth-1 row, the sprint lists only its own tickets, and the resource url
  AND kind arrays are exact (dedupe + ordering + parse all load-bearing).

**`test/query.roadmap.test.ts` — the carry-over's own cases**
- `test/query.roadmap.test.ts:90-108` — **"the progress line is TICKET-INCLUSIVE: one done ticket and
  NO cache reads 1/1"**: one sprint, one ticket driven to `done` through the real writers, an explicit
  assertion that `sprint_progress` holds **no row** for it (`:103`), then
  `expect(hit.body).toContain("Progress: 1/1 closed")` (`:107`).
- `test/query.roadmap.test.ts:110-135` — the two halves ADD (`Progress: 2/4 closed`, `:132`, where the
  cache alone reads 1/2) and a sprint with neither carries no line (`not.toContain("Progress:")`,
  `:134`). With the pre-existing `2/5` cache-only case at `:70-88`, the line is pinned at four distinct
  values — no constant satisfies all of them.

**Skills + docs**
- `plugins/canopy/skills/canopy/SKILL.md:4` — `allowed-tools` now lists all four:
  `mcp__canopy__list_tickets, mcp__canopy__get_ticket, mcp__canopy__list_sprints, mcp__canopy__get_sprint`.
  Names match the `server.tool(...)` registrations byte for byte. The prose at `SKILL.md:60-66` and
  `canopy/references/querying.md:58-63` (written in Phase 3) already used exactly these names.
- `plugins/canopy/skills/load-context/SKILL.md:4` — `allowed-tools` gains `mcp__canopy__list_tickets`
  and `mcp__canopy__get_sprint` (the two orientation reads); `:37-38` adds `sprint` / `ticket` to the
  documented `types`; `:55-59` adds read-only step 6, which calls exactly those two granted tools and
  restates that tickets and sprints have no MCP write path.
- `plugins/canopy/skills/update-plan/SKILL.md` — **unchanged**
  (`git diff c08a248..8b33fc6 -- plugins/canopy/skills/update-plan/` is empty).
- All six `.claude/skills/*` symlinks resolve into `plugins/canopy/skills/` and each target's
  `SKILL.md` is readable (verified with `readlink -f` + `test -f`).
- `CLAUDE.md:133-145` — the assembled-sprint-body rule and the "**MCP gets read tools only for tickets
  and sprints**" paragraph naming all four and stating there is no write counterpart.

### Commands

```
$ npm test
 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never hits the network)
AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality

Expected: "excerpt"
Received: "gemini-2.5-flash-lite"

 ❯ test/summarize.test.ts:197:27

 Test Files  1 failed | 87 passed (88)
      Tests  1 failed | 818 passed (819)
   Start at  06:04:39
   Duration  30.30s (transform 13.64s, setup 319.78s, import 12.84s, tests 13.74s, environment 10ms)
```
The ONE accepted environmental failure (a real `GEMINI_API_KEY` in local `.dev.vars` leaks into the
vitest pool — CLAUDE.md › Conventions & gotchas, §D). Identical to Phases 1a/1b/2/3. +14 tests over the
Phase 3 baseline (805 → 818 passing, 87 → 88 files): 12 in `mcp.tickets`, 2 in `query.roadmap`.

```
$ npm run typecheck
npm notice run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics — exit 0)

$ npm run build:web
vite v6.4.3 building for production...
✓ 21 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.39 kB
dist/assets/index-DGylmM7v.css   13.09 kB │ gzip:  3.39 kB
dist/assets/index-DnrjgSXP.js   240.19 kB │ gzip: 68.49 kB
✓ built in 363ms
```
Byte-identical hashes to Phases 2 and 3 — `web/` was not touched, as expected for this phase.

```
$ git diff c08a248..8b33fc6 --stat
 CLAUDE.md                                   |  10 +-
 plugins/canopy/skills/canopy/SKILL.md       |   2 +-
 plugins/canopy/skills/load-context/SKILL.md |  11 +-
 src/mcp.ts                                  |  55 ++++-
 src/tools/reads.ts                          |  32 ++-
 src/tools/sprints.ts                        |  19 +-
 test/mcp.tickets.test.ts                    | 364 ++++++++++++++++++++++++++++
 test/query.roadmap.test.ts                  |  53 ++++
 8 files changed, 531 insertions(+), 15 deletions(-)

$ git diff c08a248..8b33fc6 -- src/index.ts
(empty — /mcp stays bearer-only, nothing in the fetch entry changed)

$ git diff --stat c08a248..8b33fc6 -- migrations docs "Canopy Frontend Design System" .claude web
(empty — no migration, no doc, no design-file, no .claude and NO web change this phase)

$ grep -nE "create_ticket|transition_ticket|toggle_assignee|add_ticket_link|set_ticket_sprint|set_ticket_parent|add_ticket_comment|create_sprint|set_sprint_active|complete_sprint|add_sprint_resource" src/mcp.ts
(exit 1 — no output: not one ticket/sprint writer is reachable from the MCP surface)

$ grep -rn "Progress: " src/
src/tools/reads.ts:418:  if (progress.total > 0) parts.push(`Progress: ${progress.closed}/${progress.total} closed`);
(one emitter, fed only by sprintProgress — no second closed/total math)

$ grep -n "allowed-tools" plugins/canopy/skills/canopy/SKILL.md plugins/canopy/skills/load-context/SKILL.md
plugins/canopy/skills/canopy/SKILL.md:4:allowed-tools: mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__list_tickets, mcp__canopy__get_ticket, mcp__canopy__list_sprints, mcp__canopy__get_sprint
plugins/canopy/skills/load-context/SKILL.md:4:allowed-tools: mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__get_my_work, mcp__canopy__list_tickets, mcp__canopy__get_sprint

$ git status --porcelain      # after every revert was restored
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
(tree clean but for this audit and the three pre-existing untracked plan docs)
```

### Revert checks

Three independent reverts, each done by the verifier on the accepted tree, run, and restored with
`git checkout -- <file>` (`git status --porcelain` verified clean after each); the pair
`test/query.roadmap.test.ts test/mcp.tickets.test.ts` was re-run at the end — **2 files / 19 tests
passed**.

- **`tools/list` carries exactly the four** — commented out the whole `get_sprint` registration,
  `src/mcp.ts:165-175` (prefixed every line with `// REVERT `) → **5 failed | 7 passed (12)**.
  Owning assertion: `test/mcp.tickets.test.ts:163` —
  `AssertionError: expected [ 'query', 'get_doc', …(11) ] to include 'get_sprint'`.
  (Also red: the non-admin case `:173`, the description case `:180` — `expected '' to match
  /read-only/i` — and both `get_sprint` behavior cases, which get `MCP error …` instead of JSON.)
  Restored → green.
- **`assignee:'me'` binds to the bearer principal** — changed `me: principal.handle` →
  `me: undefined` at `src/mcp.ts:143` → **1 failed | 11 passed (12)**. Owning assertion:
  `test/mcp.tickets.test.ts:233` — `AssertionError: expected [] to deeply equal [ 13, 17 ]`
  (`expect(mine.map((t) => t.id).sort()).toEqual([q.loginBug, q.declined].sort())`). Restored → green.
- **The assembled sprint body is ticket-inclusive** — replaced the `sprintProgress` call in
  `assembleSprintBody` (`src/tools/reads.ts:413-418`) with the pre-Phase-4 cache-only line
  (`if (cache) parts.push(...)`) → **2 failed | 5 passed (7)** in `test/query.roadmap.test.ts`.
  Owning assertion: `test/query.roadmap.test.ts:107` —
  `AssertionError: expected 'wombat subsystem' to contain 'Progress: 1/1 closed'`.
  (Also red: `:132` — `expected 'numbat subsystem\nProgress: 1/2 closed' to contain 'Progress: 2/4
  closed'`, which pins that the two halves ADD rather than either one winning.) Restored → green.

### Gaps / deviations

**1. The description regex is a real coupling, and the implementer flagged it.**
`test/mcp.tickets.test.ts:178-186` asserts the four tool descriptions against `/read-only/i`,
`/never GitHub issues/i` and `/human-only|no MCP write path/i`. This is deliberate — the description is
the only thing an agent reads before choosing a tool, so those four facts are contract, not prose — and
the regex shape lets the wording evolve. But it does mean an innocuous rewrite of a description in
`src/mcp.ts:135/148/160/167` that drops one of those phrases reds a test with no behavior change.
Accepted as designed; recorded so the coupling is not a surprise later.

**2. A sprint with neither tickets nor cache renders NO `Progress:` line** (`src/tools/reads.ts:418`,
guard `progress.total > 0`; asserted at `test/query.roadmap.test.ts:134`). Verified: this is what the
code does, and it matches the pre-existing behavior the old `if (progress)` guard produced for a sprint
with no cache row. One narrow behavior change rides along: a sprint whose cache row is literally `0/0`
used to print `Progress: 0/0 closed` and now prints nothing. No test covered that shape and the
orchestrator accepted the rule; the `SprintView` DTO still reports `{closed:0,total:0,pct:0}`, so the
structured surface is unaffected. §A's "A sprint with no tickets and no github_ref shows 0/0" is about
the Roadmap card, which reads the DTO, not the assembled body.

**3. `load-context/SKILL.md` grants two of the four, not four** (`SKILL.md:4`: `list_tickets` +
`get_sprint`). Deliberate (the implementer's decision 9: those are the two orientation reads;
`get_ticket` / `list_sprints` are follow-ups reachable through the `canopy` skill, which grants all
four). The skill is internally consistent — step 6 at `:55-59` instructs exactly the two tools it
grants, and neither name is misspelled. Deviates from the letter of "both files list the four" but not
from any §A/§4 requirement; flagging for the orchestrator rather than treating it as a defect.

**4. No `ticket_badge` MCP tool.** §4 names four tools; `ticket_badge` (`src/tools/reads.ts`) stays a
cookie route for the sidebar. Correct — adding a fifth would also red the equality assertion at
`test/mcp.tickets.test.ts:166`.

**5. `list_tickets` has no `limit` / pagination at the MCP seam.** The Phase 2 read function has none
(Phase 2 decision 9) and adding one only here would make the two surfaces disagree. Not in §4. Worth a
follow-up once the queue is large, since `query()`'s `ticket` type is the bounded path and
`list_tickets` is not.

**6. Out of scope by design, confirmed not started.** No SPA (Phase 5 — `git diff --stat … -- web` is
empty and the `build:web` hashes are byte-identical to Phase 3). No `ticketq` notification kind
(Phase 6). `npm run seed:dev` not executed (needs a local wrangler D1) — unchanged from Phase 3.

**Verdict: ACCEPT.** Exactly four ticket/sprint tools exist on the MCP surface, registered for every
principal above the single admin branch, and not one of the eleven ticket/sprint writers is reachable
from `src/mcp.ts` — asserted by an equality, not a subset. `/mcp` stays bearer-only (`src/index.ts`
untouched). `assignee:'me'` is bound to the bearer principal and proved so by a genuine two-principal
test with disjoint expected sets. The Phase 3 carry-over is fixed at the one place the rule lives:
`assembleSprintBody` now runs both halves through `sprintProgress`, `src/tools/reads.ts:418` is the
only `Progress:` emitter, and a sprint with one done ticket and no cache reads `1/1`. Suite green but
for the accepted environmental failure; typecheck and build clean; three reverts each turned a specific
named assertion red and restored green.

---

## Phase 5 — SPA (commits 12b73de, 34f8e2b)

Base `8b33fc6` (phase 4). Verified independently: the verifier did not write this code and did not edit
product code or tests (six scratch reverts, each restored with `git checkout --` and re-run green).
The four orchestrator rulings for this phase are checked in Gaps 1–4 below.

### Delivered

**Shared — the zod-free cores (ruling (a))**
- `shared/tickets-core.ts:34-38` — `TICKET_TRANSITIONS`, the **only** transition table in the repo
  (`grep -rn "TICKET_TRANSITIONS\|canTransition\|legalMoves" --include="*.ts"` → declared once here,
  read at `:41`/`:46`, `src/tools/tickets.ts:142`, `web/src/tickets.ts:457`, and the two test files);
  `:41` `canTransition`, `:46` `legalMoves` (returns a copy), `:50` `TICKET_STATUS_LABEL`,
  `:58` `isOpenStatus`; `:1-31` vocab tuples + types. No imports at all.
- `shared/tickets.ts:22` re-exports all nine symbols; `:152` the pointer comment where the block used
  to live. `src/tools/tickets.ts:21` still imports `canTransition` from `@shared/tickets` — the split
  is invisible to the server.
- `shared/sprints-core.ts:14-17` — `SPRINT_URGENCIES` / `SPRINT_DOMAINS` / `SPRINT_STATUSES` /
  `SPRINT_RESOURCE_KINDS`; `shared/sprints.ts:32-40` re-exports. Header at `:1-12` states the bundle
  reason. **Browser bundle carries no zod**: `grep -c ZodError web/dist/assets/*.js` → `0` (Commands).

**Sidebar (design 69 / call #2)**
- `web/src/render.ts:496` — the Tickets nav item, registered **after Feed and before the Knowledge
  section label** (`goMyWork`, `goRoadmap`, `goFeed`, **`goTickets`**, then Docs). The inline SVG is
  byte-identical to the design's at `Canopy Tickets.dc.html:69`: `width="18" height="18"
  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"`.
- `web/src/render.ts:468-473` — `ticketExtra`: hidden entirely at 0 (`s.ticketBadge > 0`), an accent
  pill (`color:var(--accent);border:1px solid var(--accent);background:var(--accent-soft)`) when
  expanded, the shared `collapsedDot` when collapsed. `--accent` IS the app's green
  (`web/src/canopy.css:23` `#9aab65`, `:24` `#8a9a5b`, `:26` `#2BFF88`).
- `web/src/canopy.css:35` — `[data-screen="tickets"|"ticketdetail"|"newticket"] .cnpy-nav.n-tickets`
  and `[data-screen="sprint"] .cnpy-nav.n-roadmap` added to the active-nav rule.
- Badge data: `web/src/api.ts:327-329` `getTicketBadge()` → `GET /tickets/badge`;
  `web/src/main.ts:608-613` `loadTicketBadge()` (boot + after every write, a failure keeps the old count);
  `web/src/main.ts:1417` the boot call.

**Header (design 95–117)**
- `web/src/render.ts:530-534` — `titles`: tickets / ticketdetail / newticket → "Tickets", sprint → "Roadmap".
- `web/src/render.ts:600-604` — `queueControls`, `s.screen === "tickets"` ONLY: the Table/Board toggle in
  the **Roadmap tab idiom** (same `gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px`
  wrapper as `roadmapControls` at `:578-582`) with the design's two 13px glyphs, then the accent
  **"Submit a ticket"** button (ruling (c) — design 117's copy verbatim).
- `web/src/render.ts:616-622` + `:512-520` `headerCrumb` — on ticketdetail / newticket / sprint the
  title becomes a `data-act="ticketsBack"` button in `var(--fg-55)` and a `›` crumb names the child
  (the ticket's title / "New ticket" / the sprint's label).

**Queue — `web/src/tickets.ts` (design 127–258)**
- `:152-175` `filterRow`: the Open/Closed/All segment (`:153-155`), a divider, then the two `<select>`s
  with the design's labels **verbatim** — `ASSIGNEE_OPTIONS` at `:146-150`
  (`Any assignee` / `Assigned to me` / `Unassigned`) equals the design's `ASG_OPTS`
  (`Canopy Tickets.dc.html:1397`), and the category select (`:160-161`) is `All categories` + the five
  raw category names, equal to `CAT_OPTS` (`:1398`).
- `:165` — the footer count `${p.tickets.length} shown · ${p.unassignedCount} unassigned`, where
  `unassignedCount` is the **org-wide** badge (`web/src/render.ts:1618` passes `s.ticketBadge`), exactly
  the design's `qCount` (`:1466`).
- `:209-225` `queueGroups` — one group per sprint in `listSprints()` order, `BACKLOG` **pushed last**
  (`:217-223`), empty groups dropped (`:224`, the design's `st: display:none`).
- `:227-240` `groupHeader` — accent dot + accent label on an active sprint, `dates` then
  `· ACTIVE` in `var(--accent)` (`:231`), `Open sprint →` per sprint group and **absent on BACKLOG**
  (`:228-230`), the hairline, and the `N ticket(s)` count with the design's singular/plural.
- `:184-197` `tableRow` — the design's 7-column grid `TABLE_COLS` (`:128`, identical string to design
  237/243): title + relation chip, requester avatar + name, category chip, priority chip, status pill,
  avatar stack + assignee text, right-aligned age. `:243-245` the matching header row.
- Row anatomy: `:44` `ticketPill` (call #5 — `:34-41`: submitted `var(--blue)`, in_progress
  `var(--accent)`, done muted `var(--fg-55)`/`--border-strong`, declined `var(--red)` at `opacity:.75`);
  `:49-56` `priorityChip` — **monochrome** (`--fg` / `--fg-55` / `--fg-40`, weight only);
  `:90-94` `avatarStack` (−7px overlap, `box-shadow:0 0 0 2px var(--bg)`, descending z-index);
  `:97-101` `assigneeLabel` (`Unassigned` / full name / `First +N`) with `font-style:italic` applied at
  `:187`/`:256` when empty; `:178-182` `relationChip` → `"N sub"` on a parent, `"↳ sub-ticket"` on a
  child, nothing otherwise; `:72-80` `age()` (the design's `42m`/`6h`/`3d`).
- `:110-116` `needsAttention` — call #6, `assignees.length === 0 && status === "submitted"`, rendered as
  `box-shadow:inset 2px 0 0 var(--accent)` + a 4% fill (`NEEDS_ATTENTION_STYLE`), applied at `:185`
  (table) and `:257` (board).
- `:268-286` `boardView` — one column per status of the current segment (`SEG_STATUSES` at `:104-108`),
  the design's head colors (`:272`), the count, the dashed "Nothing here" placeholder (`:273-275`), and
  the `repeat(N,minmax(0,1fr))` grid (`:285`). `:255-266` `boardCard` carries the sprint tag, exactly
  where the design puts it (design 216).

**New ticket — `web/src/tickets.ts:321-369` (design 259–298)**
- `:322` `canSubmit = p.title.trim().length > 0` → `primaryBtn("Submit ticket", canSubmit, "ntSubmit", …)`
  at `:365`; title is the only required field.
- Placeholders **verbatim** against design 265/267/269: `:345` `One line: what do you need?`,
  `:347` `What's happening, and what would good look like?`, `:349` `GitHub or Figma URL, or #issue-number`.
- `:324-325` category chips, none selected by default (`web/src/render.ts:230` `fCat: null`) →
  `web/src/main.ts:1031` submits `state.fCat ?? "other"`; `:327-328` the priority segment defaulting
  `normal` (`render.ts:230`); `:330-332` sprint chips with **Backlog first and selected by default**
  (`fSpr: null`); `:334-338` assignee chips with a dashed-avatar **Unassigned** chip first (selected at
  `fAsgs: []`) and multi-select toggling at `main.ts:1028-1031`.
- Submit → queue + toast: `web/src/main.ts:1045-1054` resets the form, sets `screen = "tickets"`,
  `loadTickets()` + `loadTicketBadge()`, then the design's `submitTicket` copy
  (`Ticket submitted — assigned to …` / `Ticket submitted — it's in the queue as Submitted`).

**Ticket detail — `web/src/tickets.ts:647-679` (design 299–489)**
- Breadcrumb: the header's `ticketsBack` button (above); `main.ts:894-897` resolves it to Tickets.
- `:650-659` header block — title, requester avatar + name, `· opened <relTime>`, transition buttons.
  Category / priority / status live in the Properties rail (`:668-672`), exactly where design 383–386
  puts them.
- `:662` the description (escaped, `white-space:pre-wrap`).
- `:466-497` `linkedWorkBlock` — chips per link with the design's three icons (`:429-433`, byte-identical
  GitHub/Figma/plain SVGs) plus `label` and `meta`; **call #8** at `:488` — the field renders while
  `!hasLinks`, and once a link exists it is replaced by the plain
  `Linked to engineering work` line (`:485-487`) with an "Add link" toggle (`:472-474`) as the only way
  back. `:443` `safeHref` neutralizes a non-http(s) stored url to `#`.
- `:394-404` `relCandidates` — §A's five exclusions verbatim (self, its parent, anything with a parent,
  anything with children, anything closed); `:610` additionally hides the affordance on a ticket that
  itself has a parent (it could never be a parent — Phase 2's rejection 1).
- `:620-626` the parent line (`↰` + `PARENT TICKET`), `:627-632` the sub-ticket rows
  (`↳` + `SUB-TICKET · <STATUS>`), `:633-638` the "No linked tickets" empty state.
- `:573-603` `sprintRail` — the pencil button opens a menu of **Backlog + every sprint** with the
  design's in-flow tick (`:439-440`, `visibility:hidden` when off so labels never shift); the rail row
  links to the sprint screen when set and reads `Backlog` / `NO SPRINT` when not.
- `:545-571` `assigneeRail` — call #7: `data-act="ticketAsgAdd"` / `ticketAsgRemove` fire straight into
  `toggleTicketAssignee` (`main.ts:1080-1092`), **no confirm step**.
- `:456-464` `transitionButtons` — driven by `legalMoves(status)`; secondaries outlined, the primary
  accent; `MOVE_LABEL` at `:407-412` gives `Start` / `Decline` / `Done` / **"Back to submitted"**
  (ruling (c), design 311). Terminal → `""` at `:458`.
- `:501-543` `threadBlock` — comments and events merged and sorted ascending by time (`:531`); the
  opening row reads **`opened · SUBMITTED`** (`:518-520`, `from_status === null`), later rows
  `<actor> · <From> → <To> · <when>`; the comment box with `Comment` inert until the draft is non-empty
  (`:533`, `:541`). `:415-427` `mentionize` escapes first, then paints known `@mentions`.

**My Work — `web/src/render.ts` + `src/tools/mywork.ts` (design 572–639, call #9)**
- `shared/dashboard.ts:42-53` `MyWorkTicket`, `:59` `DashboardData.tickets` — a field of its own,
  commented "NEVER in `todo`".
- `src/tools/mywork.ts:155-179` `listAssignedTickets` — one query joined to `sprints` for the label,
  `WHERE t.status IN ('submitted','in_progress')` (`:163`), `ORDER BY t.updated_at DESC, t.id DESC`,
  `LIMIT 6` (`:17` `TICKET_LIMIT`, the same cap as PR/todo).
- `src/tools/mywork.ts:198` — read **before** the github-identity fork, so a Google-only person still
  gets their tickets; `:199` and `:220` are the only two returns and both carry `tickets` as a separate
  field. `grep -n "todo" src/tools/mywork.ts` shows `todo` is built solely by `listOpenAssignedIssues`
  (`:215`) — **no ticket ever enters it** (revert check D).
- `web/src/render.ts:1502-1520` `ticketCard` — the To-do card treatment (`MW_CARD`, `mwRow`, `mwFooter`):
  title + a `#<id>` pill that is a `data-act="openTicket"` button (not an external link), Summary row
  (collapses on an empty body), Requester row, Sprint row (`Backlog` when none), footer = status pill +
  monochrome priority chip + `updated <relTime>`.
- `web/src/render.ts:1547-1553` the third block's body, `:1555` `mwSection("Tickets assigned to me", …)`,
  `:1557` the order `${hero}${todo}${activity}${tickets}` (ruling (d)). Empty copy at `:1550` is
  **exactly** `No tickets assigned to you. The queue has what's waiting.`; `degraded` shows a hint
  instead (`:1548`).

**Roadmap — `web/src/sprints.ts` + `web/src/render.ts` (design 770–805)**
- `web/src/sprints.ts:109-162` `sprintCard`: label (`:145`), NEXT UP only when `!done && !sp.active`
  (`:116`, `:146`), the tags (`:149`), lead avatar + **first** name + `· lead` (`:76-79`), summary
  (`:152`), `phase · dates` (`:124-126`), the progress bar (`:129-134`) with `closed/total done`
  (`:132`) and no bar at all when `total === 0` (`:111`), member avatars (`:156`) and
  `Open sprint →` (`:158`).
- `web/src/sprints.ts:65-73` `sprintTags` — the design's `sprTagsOf` (`:1580-1587`) order exactly:
  exactly one urgency tag (`▲ HIGH` in `tint(var(--amber))` / `NORMAL` / `LOW`), then `DUE <short>`
  only when there is a due date (`:42-46` turns the ISO date into `OCT 17`), then the DOMAIN uppercased
  in `tint(var(--blue))`.
- `web/src/render.ts:872-912` the Timeline tab: the design's intro copy (`:888-892`), the
  `newSprintToggle` in the header row (`:901`), the panel above the first group (`:904-907`), then the
  In Progress / Upcoming / Done groups (`:908-910`) with empty groups dropped (`:884`).
  `web/src/render.ts:578-582` — the Narrative / Timeline tabs are unchanged.
- `web/src/sprints.ts:194-244` `newSprintPanel` — the Phase 3 fields: Sprint name, Dates, Goal
  (→ `summary`), the **urgency segment** (`:198-199` over `SPRINT_URGENCIES`), Due date, **lead chips**
  (`:201-202`, one per person, click again to clear), **domain chips** (`:204-205` over
  `SPRINT_DOMAINS`), the design's footnote (`:238`) and Cancel / Create sprint (`:240-241`, inert until
  the name is non-empty, `:196`/`:207-209`). `:247-249` `newSprintToggle`. Wiring:
  `web/src/main.ts:920-962` (`nsToggle`/`nsField`/`nsUrg`/`nsLead`/`nsDom`/`nsCreate`).

**Sprint screen — `web/src/sprints.ts:314-384` (design 490–571)**
- `:340` title, `:342` the ACTIVE chip, `:344` the phase, `:363-364` DATES / DUE in the properties rail,
  `:365-366` the URGENCY and DOMAIN tags.
- `:346-350` the description through **`renderMarkdown`** (imported at `:23`) inside a `cnpy-md`
  wrapper — NOT `esc` — with a plain-escaped `summary` fallback when there is no description.
- `:282-291` `sprintTicketRow` — `depth === 1` adds `padding-left:34px` **and** the `↳` chevron
  (`:284-285`); `:321-323` the design's empty state.
- `:271-279` `resourceRow` (the same three icons as the ticket detail, `:263-267`), `:330-332` the list,
  `:376-379` the "Add a URL…" field + Add button; `:269` `safeHref`.
- `:325-328` members, one row per handle with the design's avatar + full name.
- `:317-319` the "Mark active / Mark inactive" control, **absent on a `done` sprint** (§C.6 — `done` is
  never cleared here).

**Settings**
- `test/render.notifications.test.ts:75-107` — a prefs view carrying a `ticketq` kind renders the
  "Ticket queue" row with all three `setKindCadence` segments and the ORG DEFAULT marker, and the row is
  absent when the org disabled the kind. Settings iterates the registry, so no SPA change was needed.

**Hash routing (§C.11) — `web/src/hash.ts`**
- `:38-62` `parseHash`: `#tickets` → `tickets` (`:45`), `#tickets/new` → `newticket` (`:47`),
  `#tickets/<id>` → `ticketdetail` + id (`:48-49`), `#sprints/<id>` → `sprint` + id (`:53-56`), every
  other bare screen name at `:58-60`, anything else → My Work (`:40`, `:61`). `:31-35` `intSeg` keeps
  `#tickets/abc` out of the detail route.
- `:66-71` `hashForRoute`, the inverse; round-trip asserted at `test/hash.test.ts:69`.
- `web/src/main.ts:164-202` `currentRoute` / `applyRoute` / `loadForScreen`; `:1408-1418` boot
  (`applyRoute(parseHash(location.hash))` + `loadTicketBadge()`).

**Invariants — verified by grep, not by claim**
- `grep -rn -i "mcp" web/src/*.ts` → only `api.ts:6` ("the MCP bearer is for /mcp only and never appears
  here"), the two section banners `api.ts:304`/`:358` ("cookie-gated, NEVER MCP") and the **pre-existing**
  Settings token-minting / Get Started copy in `render.ts`. **No MCP call path in the SPA.**
- Every ticket/sprint write goes through the cookie client: `web/src/api.ts:330-357` (the ten ticket fns
  over `ticketWrite` → `postJson`) and `:359-377` (the five sprint fns), all on `postJson`/`getJson`
  which set `credentials: "same-origin"` (`api.ts:31`, `:40`, `:56`). No `fetch` anywhere in
  `web/src/tickets.ts` / `web/src/sprints.ts` (pure views).
- **No client-side inference of done/declined**: `grep -n "done\|declined" web/src/tickets.ts
  web/src/sprints.ts web/src/main.ts` returns only display reads — `sprints.ts:110`
  (`opts.done ?? sp.status === "done"`, the server's own status or the explicit human Confirm-done click),
  `:317` (hide the active toggle on a done sprint), `tickets.ts:39`/`:106-107` (pill tint, segment sets).
  Nothing computes a status; every move is `transitionTicket()` → `POST /tickets/:id/status`.

### Commands

```
$ npm test
 Test Files  1 failed | 90 passed (91)
      Tests  1 failed | 945 passed (946)
   Start at  06:56:14
   Duration  30.81s (transform 13.09s, setup 335.01s, import 17.98s, tests 12.77s, environment 8ms)

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
   GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never
   hits the network)
 AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality
 ❯ test/summarize.test.ts:197:27
```
The single failure is the accepted environmental baseline (§D / CLAUDE.md › Conventions & gotchas).
Net of the phase: +3 test files, +172 tests (88/774 at phase 4 → 91/946).

```
$ npm run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics — exit 0)
```

```
$ npm run build:web
vite v6.4.3 building for production...
✓ 26 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.40 kB
dist/assets/index-EQGAp5Ww.css   13.60 kB │ gzip:  3.50 kB
dist/assets/index-Fc6hpARR.js   304.55 kB │ gzip: 83.41 kB
✓ built in 373ms

$ grep -c ZodError web/dist/assets/*.js
0
```
Ruling (a) holds: the `*-core.ts` split keeps zod out of the browser (240 kB at phase 4 → 304 kB is the
three ticket screens + the three sprint views, not a runtime library).

```
$ git diff --stat 8b33fc6..34f8e2b -- migrations docs "Canopy Frontend Design System" .claude
(empty)

$ git diff --stat 8b33fc6..34f8e2b -- src/notifications
(empty)

$ git status --porcelain
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
```
No migration, doc, design, `.claude` or notification file was touched. The only `src/` changes are
`src/tools/mywork.ts` (the ticket projection) and `src/routes.ts:284` (the `/me/dashboard` backstop
literal gaining `tickets: []`). Tree clean after every revert was restored, except this audit and the
three pre-existing untracked plan docs.

```
$ grep -rn "TICKET_TRANSITIONS\|canTransition\|legalMoves" --include="*.ts" shared src web test
```
One declaration — `shared/tickets-core.ts:34` — read by `shared/tickets.ts:22` (re-export),
`src/tools/tickets.ts:142`, `web/src/tickets.ts:457` and the two test files. **No second table.**

### Revert checks

- **A — only legal transition buttons.** `web/src/tickets.ts:457` changed from
  `const moves = legalMoves(status);` to a hardcoded `["in_progress","declined","done","submitted"]`.
  `npx vitest run test/render.tickets.test.ts` → **3 failed | 61 passed (64)**;
  `test/render.tickets.test.ts:499:22` — `expected '<div style="max-width:1000px…' not to contain
  'data-arg="done"'` (the submitted case), `:509:22` — same for `data-arg="declined"` from in_progress,
  `:516:24` — `not to contain 'data-act="ticketStatus"'` (the terminal case). Restored → 64 passed.
- **B — the needs-attention rule (call #6).** `web/src/tickets.ts:113` changed from
  `t.assignees.length === 0 && t.status === "submitted"` to `t.assignees.length === 0`.
  → **4 failed | 60 passed (64)**; `test/render.tickets.test.ts:296:71` — `expected true to be false`
  (the three "leaves plain: unassigned + in progress / done / declined" table cases), and
  `:302:77` — `expected 4 to be 1` (the mixed-queue case counts the inset rules). Restored → 64 passed.
- **C — NEXT UP only on an inactive sprint.** `web/src/sprints.ts:116` changed from
  `!done && !sp.active` to `!done`. `npx vitest run test/render.sprints.test.ts` →
  **1 failed | 36 passed (37)**; `test/render.sprints.test.ts:171:105` —
  `expected '<div style="padding:14px 16px;border:…' not to contain 'NEXT UP'`. Restored → 37 passed.
- **D — tickets are never in `todo`.** `src/tools/mywork.ts:220` changed to append the ticket rows onto
  `todo` as well as returning them in `tickets`.
  `npx vitest run test/mywork.test.ts test/dashboard-route.test.ts` → **2 failed | 17 passed (19)**;
  `test/mywork.test.ts:354:23` — `expected [ { number: 7, …(11) } ] to deeply equal []` ("drops a ticket
  once a person closes it (done AND declined), and never puts tickets in todo"), and
  `test/dashboard-route.test.ts:139:23` — `expected [ { number: 1, …(11) } ] to deeply equal []`
  ("carries the third list — open tickets assigned to the principal, never in todo"). Restored → 19 passed.
- **E — the My Work empty copy, one word.** `web/src/render.ts:1550` `"…The queue has what's waiting."`
  → `"…The backlog has what's waiting."`. `npx vitest run test/render.mywork.test.ts` →
  **1 failed | 49 passed (50)**; `test/render.mywork.test.ts:496:18` — `expected '<div
  data-cnpy-theme="dark" data-scre…' to contain 'No tickets assigned to you. The queue…'`.
  Restored → 50 passed.
- **F — the `#sprints/<id>` route round-trip.** `web/src/hash.ts:69` changed to return `"#roadmap"`
  unconditionally for the sprint screen. `npx vitest run test/hash.test.ts` →
  **2 failed | 6 passed (8)**; `test/hash.test.ts:56:77` — `expected '#roadmap' to be '#sprints/7'`, and
  `:69:64` — `expected { screen: 'roadmap', …(2) } to deeply equal { screen: 'sprint', …(2) }`
  (the round-trip property). Restored → 8 passed.

Final restore confirmed: `git status --porcelain` lists only this audit and the three pre-existing
untracked plan docs, and
`npx vitest run test/render.tickets.test.ts test/render.sprints.test.ts test/render.mywork.test.ts
test/hash.test.ts test/mywork.test.ts test/dashboard-route.test.ts` →
**6 files, 178 tests passed**.

### Gaps / deviations

**1. Ruling (a) — `shared/tickets-core.ts` / `shared/sprints-core.ts`: confirmed correct.** There is
exactly ONE transition table (`shared/tickets-core.ts:34`, proved by the repo-wide grep above and by
revert check A biting in the browser while `src/tools/tickets.ts` reads the same constant), every prior
import path still resolves (`shared/tickets.ts:22`, `shared/sprints.ts:32-40`; `test/tickets.contract.test.ts`
and `src/tools/tickets.ts` were not touched), and the browser bundle greps **0** `ZodError`.

**2. Ruling (b) — the New sprint panel is on the Roadmap Timeline, not the queue filter row: confirmed.**
The design puts the "New sprint" button and panel inside the queue's filter row
(`Canopy Tickets.dc.html:156-197`); §5 assigns `newSprintPanel` to `web/src/sprints.ts` and the
orchestrator ruled Roadmap. `web/src/render.ts:901` renders `newSprintToggle` in the Timeline header and
`:904` the panel above the first group; `web/src/tickets.ts:167-174` has no trace of it. The panel's own
markup, field order and copy are the design's line for line.

**3. Ruling (c) — header copy: confirmed.** `web/src/render.ts:604` reads **"Submit a ticket"**
(design 117) and `web/src/tickets.ts:411` `MOVE_LABEL.submitted` reads **"Back to submitted"**
(design 311), not the brief's shorthands "New ticket" / "Back". The form's own button is
`"Submit ticket"` (`tickets.ts:365`), matching design 294.

**4. Ruling (d) — My Work block order: confirmed.** `web/src/render.ts:1557` is
`${hero}${todo}${activity}${tickets}` — To-do, Previous activity, Tickets assigned to me — which is the
design's order (`Canopy Tickets.dc.html:575` / `597` / `619`) and §A's "a third block". Pinned by an
`indexOf` chain at `test/render.mywork.test.ts:487`.

**5. Frame-for-frame deviations found (all minor, none a brief requirement).**
   - *Filter dropdowns are native `<select>`s* (`web/src/tickets.ts:157-161`) where the design uses custom
     popovers with a chevron and an in-menu tick (design 137–154). Consequence: §5's `qMenu` AppState
     field does not exist (a `<select>` has no open flag) — the four **detail** popovers `lkOpen` /
     `asgMenu` / `sprMenu` / `relMenu` are custom and ARE in state (`render.ts:232-234`). The option
     labels are byte-equal to the design's. Instructed by the phase prompt; recorded for completeness.
   - *The Roadmap card's badge reads `NEXT UP`, the design's literal is `NEXT`*
     (`web/src/sprints.ts:146` vs `Canopy Tickets.dc.html:783`). §A and §5 both say "NEXT UP badge",
     so the brief's copy won. Deliberate; worth one line if the design is ever re-synced.
   - *The sprint screen's ticket rows carry no assignee avatars* (`web/src/sprints.ts:284-290`); the
     design's `spTickets` row has `q.avs` between the status pill and the age (design 514). Neither §A
     ("ticket list with children indented under roots and a ↳ chevron") nor §5 asks for them, and
     `SprintDetail.tickets` is `TicketRow & {depth}` (`shared/sprints.ts:119`), which carries no
     assignee array — adding them would need a Phase 3 DTO change. Not a defect; the one visible
     difference from the design's sprint frame.
   - *The board card's title has no `-webkit-line-clamp:2`* (`web/src/tickets.ts:258` vs design 214).
     Cosmetic only.
   - *The breadcrumb separator is `›`, the design's markup uses `/`* (`web/src/render.ts:618`).
     Instructed by the phase prompt.
   - *The queue's needs-attention rows lose the `.cnpy-trow:hover` background* — the inline
     `NEEDS_ATTENTION_STYLE` background beats the CSS rule. The inset accent rule still reads. The
     implementer judged a `!important` worse; agreed.
   - *AppState field names*: §5 lists `fGh` / `ghDraft`; the code uses `fLink` / `linkDraft`
     (`render.ts:230-232`) because a link may be Figma or plain, not only GitHub. Cosmetic.

**6. Additions beyond the design, each defensible.**
   - *The "Add link" toggle* (`web/src/tickets.ts:472-474`) is shown only once a link exists. Call #8
     says the field hides after the first link; without a toggle a second link would be unaddable. The
     design shows the toggle unconditionally, so this is strictly narrower than the design and satisfies
     call #8 (asserted three ways, `test/render.tickets.test.ts:521-544`).
   - *"Mark active / Mark inactive"* on the sprint screen (`web/src/sprints.ts:317-319`) — the brief
     gives `POST /sprints/:id/active` no UI. It is absent on a `done` sprint, so §C.6's "done is
     admin-only" is preserved.
   - *The Confirm-done row stays on the card* (`web/src/sprints.ts:136-141`) with its copy widened to
     "Every ticket and issue in this sprint is closed" — progress became ticket-inclusive in Phase 3, so
     the old wording was false. Same act, same `data-arg`.
   - *The sub-ticket add affordance is hidden on a ticket that already has a parent*
     (`web/src/tickets.ts:610`) — the route 409s on that case, so the menu would always fail.

**7. `test/render.roadmap.test.ts` changed from "4/6 closed" to "4/6 done"** (3 assertion lines). The
Timeline card is the design's card now and the design's count string is `closed + "/" + total + " done"`
(`Canopy Tickets.dc.html:1595`). The Narrative tab's `roadmapDigest` still says "closed" — §5 leaves it
unchanged. A deliberate copy change to a pre-existing test, not a weakened assertion (the exact string
is still asserted, and the 0/0 case's negative assertion moved with it).

**8. Naming: `roadmapNarrative()` renders the TIMELINE tab.** `web/src/render.ts:872` — the function is
the Timeline renderer (`roadmapView` at `:920` sends `roadmapTab === "narrative"` to `roadmapDigest`
and everything else here). Pre-existing name, not introduced by this phase; confusing on a first read.

**9. Out of scope by design, confirmed not started.** Phase 6 (email) — `git diff --stat … --
src/notifications` is empty, there is no `ticketq` kind, and the Settings row is proved only against a
synthetic prefs view (`test/render.notifications.test.ts:75-107`). No sprint EDIT surface and no resource
delete (the design's Resources list is add-only). No queue pagination (`GET /tickets` has none). No
sprint-level ticket creation. `npm run seed:dev` not executed (needs a local wrangler D1) — unchanged
from Phase 3.

**Verdict: ACCEPT.** Every §A Phase 5 bullet is on screen at a named file:line, matched against the
locked design frame by frame; the nine design calls that touch this phase (#2, #5, #6, #7, #8, #9) are
each implemented at one place and each asserted; all four orchestrator rulings hold in the code; there
is exactly one transition table and no zod in the browser; every write is a cookie-client call and
nothing in the SPA infers `done`/`declined`; the suite is green but for the accepted environmental
failure, typecheck and build are clean; and six independent reverts each turned a specific named
assertion red and restored green.

---

## Phase 6 — email (commit 0a129e8)

Base `34f8e2b`. Diff is six files: one new renderer, one registry line, one CLAUDE.md paragraph,
one new test file and two list-of-kinds test edits. Verified independently; the verifier wrote no
product code, and every scratch edit below was restored with `git checkout --` before the next one.

### Delivered

- `src/notifications/renderers/ticket-queue.ts:137-144` — `export const ticketQueueKind:
  NotificationKind<DB>`: `id: "ticketq"`, `label: "Ticket queue"`, `description: "New and unassigned
  tickets across the org."`, `defaultCadence: "daily"`, `allowedCadences: ["daily","weekly","off"]`
  (`off` present, per spec §2), `render`. Matches §6 word for word.
- `src/notifications/registry.ts:9,11` — `ticketQueueKind` imported and appended to `REGISTRY`
  **fourth**. That single line is the whole wiring: `policy.ts:10` seeds `notification_policy` by
  iterating `REGISTRY`, `notifications/routes.ts:30,108,211` builds the Settings prefs view, the
  Maintenance policy view and the enabled-kinds filter from it, and `run.ts:116` resolves it like
  any other kind. No migration, no new HTTP surface, no SPA change — confirmed by the scope grep.
- `src/notifications/renderers/ticket-queue.ts:49-60` — part one, `unassignedTickets(db)`:
  `WHERE t.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.ticket_id
  = t.id)`, org-wide, `ORDER BY t.created_at DESC, t.id DESC`. Requester resolved to a display name
  in the same statement (`LEFT JOIN persons … COALESCE(NULLIF(p.name,''), t.requester)`). Not
  window-scoped — the queue is state, like `review_queue`.
- `src/notifications/renderers/ticket-queue.ts:71` — part two is `listAssignedTickets(db, handle)`
  from `src/tools/mywork.ts:155-180`, the SAME read My Work renders (`status IN
  ('submitted','in_progress')`, `updated_at DESC`, `LIMIT TICKET_LIMIT = 6`), so the digest and the
  app cannot disagree on "assigned to me". This mirrors how `my-work.ts` reuses
  `listOpenAssignedIssues`. The two halves are disjoint by construction (no assignees vs. assigned
  to the recipient).
- `src/notifications/renderers/ticket-queue.ts:72` — `return null` when both halves are empty;
  null sections are dropped by the assembler, so an empty queue yields a `skipped` outbox row.
- `src/notifications/renderers/ticket-queue.ts:79-101` (UNASSIGNED) and `:105-124` (ASSIGNED TO
  YOU) — HTML through the shared `EMAIL_STYLE` / `EMAIL_CARD` / `EMAIL_SPACE` helpers
  (`K.item` / `K.row` / `K.chip`), each half with a matching plain-text ledger built from the same
  `pad()` idiom as the other renderers. `heading: "Ticket queue"`, `deepLink: "/#tickets"`,
  `linkLabel: "Tickets"` at `:134` — the deep link the brief asks for.
- `src/notifications/renderers/ticket-queue.ts:84,87,90,110,113,116` — every user-supplied string
  interpolated into HTML (title, category, requester name, sprint label, age) goes through
  `escapeHtml` (`src/notifications/html.ts:4`). The text alternative is deliberately unescaped.
- `src/notifications/renderers/ticket-queue.ts:22-31` — local `age()` ("42m"/"6h"/"3d") measured
  against `window.end`, not `Date.now()`: the digest states the queue as of the run, and the
  rendered string is deterministic in tests.
- `src/notifications/renderers/ticket-queue.ts:130-132` — the summary line.
- **Pure read, verified by grep:** `grep -niE "insert|update |update\(|delete|run\(|first\(|batch|
  prepare" src/notifications/renderers/ticket-queue.ts` → no match. The file's only DB call is
  `all()` (`:50`) plus the `all()` inside `listAssignedTickets`. `test/notifications.ticketq.test.ts:62-68,
  122-125` additionally snapshots row counts across `tickets`, `ticket_assignees`, `ticket_events`,
  `ticket_comments`, `ticket_links`, `sprints`, `persons` before and after a render and asserts
  they are identical.
- **No per-event mail, verified by grep:** `grep -rn "notifications/" src/tools/ src/webhook.ts
  src/consumer.ts` → no match. `src/routes.ts` touches `src/notifications/` only at `:8` (mounting
  `/api/notifications`) and `:33` — `sendInvite`, called at `:253` and `:266`, both inside the
  invite routes, neither on a ticket or sprint path. `src/routes.ts`, `src/tools/tickets.ts`,
  `src/tools/sprints.ts` and `src/webhook.ts` are untouched by this commit.
- `CLAUDE.md:263-268` — the Email notifications registry bullet now names `ticketq` and states what
  it reads (not window-scoped; unassigned `submitted` org-wide plus the recipient's own via
  `listAssignedTickets`).
- `test/notifications.ticketq.test.ts` (new, 287 lines, 12 tests) — rows not mocks: tickets created
  through the real `create_ticket` / `transition_ticket` writers, digests through `runDigest` in
  local mode, assertions on `notification_outbox` and the dev-only `notification_outbox_bodies`.
  Registry entry + exact metadata (`:80-89`); `seedNotificationPolicy` inserts `ticketq`
  enabled/daily/`updated_by='registry'` (`:91-100`); null when nothing qualifies (`:104-113`);
  unassigned half — newest-first, excludes an unassigned `in_progress` one and an assigned
  `submitted` one, carries category/priority/requester name/age, and is a pure read (`:115-147`);
  assigned half — includes `submitted` + `in_progress` with the pill label and sprint label,
  excludes `done`, `declined` and another person's (`:149-175`); combined summary (`:177-182`);
  HTML escaping (`:184-189`); `runDigest` writes exactly ONE row keyed `AndresL230:daily:2026-09-11`
  with `ticketq` in `kinds` and the title in the body, and a second identical run adds nothing
  (`:195-212`); all-null run → `skipped`, `kinds "[]"`, zero bodies (`:214-221`); a `weekly` user
  pref moves it out of the daily run into the weekly one (`:223-240`); `GET
  /api/notifications/policy` lists it with `registryDefault: "daily"` and the full allowed set
  (`:244-258`); `PUT /policy {enabled:false}` flips the row, removes it from `GET /prefs` AND from
  the next run's `kinds` — `skipped`, no body (`:260-286`). Both §6-mandated policy/prefs tests are
  present and are driven through the real cookie-gated routes via `app.request`.
- `test/notifications.registry.test.ts:45-56` and `test/notifications.routes.test.ts:49,137` —
  list-of-kinds expectations widened to four kinds; no production behavior changed to make them
  pass. `test/notifications.schema.test.ts` and `test/render.notifications.test.ts` needed no edit
  (the first iterates `REGISTRY` dynamically, the second's "Ticket queue" Settings-row case from
  Phase 5b renders off a synthetic prefs view).

### Commands

```
$ npm test
 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
       GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt
 AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt'   (test/summarize.test.ts:197:27)

 Test Files  1 failed | 91 passed (92)
      Tests  1 failed | 957 passed (958)
   Duration  31.14s (transform 14.29s, setup 341.05s, import 15.30s, tests 12.96s, environment 13ms)
```
The single failure is the accepted environmental baseline (a real `GEMINI_API_KEY` in `.dev.vars`
leaks into the vitest pool — CLAUDE.md › Conventions & gotchas, §D of the brief). Unrelated to
this phase and present at every earlier phase.

```
$ npm run typecheck
npm notice run typecheck
npm notice run tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics)
```

```
$ npm run build:web
vite v6.4.3 building for production...
✓ 26 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.40 kB
dist/assets/index-EQGAp5Ww.css   13.60 kB │ gzip:  3.50 kB
dist/assets/index-Fc6hpARR.js   304.55 kB │ gzip: 83.41 kB
✓ built in 388ms
```

```
$ git diff --stat 34f8e2b..0a129e8 -- migrations docs "Canopy Frontend Design System" .claude web
(empty)

$ git diff --stat 34f8e2b..0a129e8
 CLAUDE.md                                   |   4 +-
 src/notifications/registry.ts               |   3 +-
 src/notifications/renderers/ticket-queue.ts | 144 ++++++++++++++
 test/notifications.registry.test.ts         |  11 +-
 test/notifications.routes.test.ts           |   4 +-
 test/notifications.ticketq.test.ts          | 287 ++++++++++++++++++++++++++++
 6 files changed, 447 insertions(+), 6 deletions(-)

$ grep -niE "insert|update |update\(|delete|run\(|first\(|batch|prepare" \
      src/notifications/renderers/ticket-queue.ts
(no match — the renderer is a pure read)

$ grep -rn "notifications/" src/tools/ src/webhook.ts src/consumer.ts
(no match — no per-event mail)

$ git status --porcelain
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
$ git diff HEAD --stat
(empty — tree clean apart from the audit and the three pre-existing untracked plan docs)
```

### Revert checks

Five, each applied to the working tree, run, then restored with `git checkout -- <file>` and
re-run green.

- **Unregister the kind** — `src/notifications/registry.ts:11`, dropped `, ticketQueueKind` from
  `REGISTRY`. `npx vitest run test/notifications.ticketq.test.ts
  test/notifications.registry.test.ts test/notifications.routes.test.ts
  test/notifications.schema.test.ts` → **14 failed | 28 passed (42)**, across all three surfaces:
  `registry.test.ts` › "has the four kinds …" at `expect(REGISTRY.map((k) => k.id)).toEqual([…,
  "ticketq"])`; `routes.test.ts` › prefs list (`expected [ 'my_work', 'roadmap_plan' ] to deeply
  equal [ Array(3) ]`) and the admin policy list; and all 10 `ticketq` tests, e.g. "seeds a
  notification_policy row" at `expect(r.inserted).toContain("ticketq")`. Restored → green.
- **Drop the no-assignee condition** — `src/notifications/renderers/ticket-queue.ts:57`,
  `AND NOT EXISTS (SELECT 1 FROM ticket_assignees …)` → `AND 1 = 1`. → **4 failed | 8 passed (12)**:
  "lists submitted tickets with no assignees …" at `test/notifications.ticketq.test.ts:131`
  (`expected '3 tickets unassigned' to be '2 tickets unassigned'`), "returns null …" at `:112`
  (`expected { heading: 'Ticket queue', …(5) } to be null`), "lists the recipient's open assigned
  tickets …" at `:168` (`not to contain 'Luke&#39;s ticket'`), and "summarises both halves …" at
  `:181`. Restored → green.
- **Return a Section even when both halves are empty** — `src/notifications/renderers/
  ticket-queue.ts:72`, deleted `if (unassigned.length === 0 && mine.length === 0) return null;`.
  → **2 failed | 10 passed (12)**: "returns null when nothing is unassigned and nothing is assigned
  to the recipient" at `test/notifications.ticketq.test.ts:112` (`expected { heading: 'Ticket
  queue', …(5) } to be null`) AND "a run where every kind renders null writes a skipped row and no
  body" at `:219` (`expected { …(10) } to match object { Object (status, kinds, ...) }` — the row
  is `sent`, not `skipped`). The renderer's null contract is load-bearing on the outbox, and both
  ends are pinned. Restored → green.
- **Drop title escaping** — `src/notifications/renderers/ticket-queue.ts:84,110`,
  `title: escapeHtml(t.title)` → `title: t.title`. → **1 failed | 11 passed (12)**: "escapes HTML in
  a ticket title" at `test/notifications.ticketq.test.ts:187`
  (`expected '<div style="font-family:\'Geist Mono\…' not to contain '<img src=x'`). Restored → green.
- **Widen the display cap** — `src/notifications/renderers/ticket-queue.ts:10`, `const TOP = 5` →
  `const TOP = 50`. → **12 passed (12), still green.** Recorded as a gap below, not a defect: §6
  mandates no cap, so the cap and its "+N more waiting in Tickets" line are the one behavior in the
  file that no test pins.

### Gaps / deviations

1. **No `ticketq` section in `src/notifications/sample.ts`.** The admin preview's canned digest
   (`&sample=1`) still shows exactly three sections (`sample.ts:31,45,58` — My Work / Review queue /
   Roadmap plan changes). §6 does not ask for one and the live preview renders `ticketq` normally,
   so this is a fixture gap, not a defect. Whoever next touches the sample fixtures should add it.
2. **Summary wording carries the noun.** §6's literal text is `"N unassigned · M assigned to you"`;
   the code emits `"3 tickets unassigned · 1 assigned to you"` (`ticket-queue.ts:130-132`, pinned by
   `test/notifications.ticketq.test.ts:131,173,181`). The noun sits on whichever half leads so a
   lone half reads grammatically ("1 ticket unassigned", "2 tickets assigned to you"). Accepted by
   the orchestrator; recorded here as a deviation from the brief's literal string.
3. **The `TOP = 5` cap on the unassigned half is untested** — raising it to 50 leaves the suite
   green (revert check 5). The cap and the `+N more waiting in Tickets` line (`:96`, `:101`) are a
   borrowed `my_work` idiom that §6 never asked for; the summary still counts the full queue, so
   the behavior is sound but unpinned. The assigned half has no such line and is capped instead at
   `listAssignedTickets`' own `TICKET_LIMIT = 6` (`src/tools/mywork.ts:17`) — a small asymmetry
   between the two halves, also unasserted.
4. **Items carry no clickable `#id`.** `K.item` is called with `number: null, url: null`
   (`:85-86`, `:111-112`); the id is plain `#12` text in the footer and the section's "Open Tickets
   →" button is the only link. A renderer has no access to the origin (the assembler prefixes only
   `deepLink`), exactly as for `review_queue` / `roadmap_plan`. Consistent, but a per-ticket deep
   link would need an assembler change.
5. **`STATUS_TONE` (`:16`) has two unreachable entries and one approximated tone.**
   `listAssignedTickets` filters to `submitted` / `in_progress`, so `done: "muted"` and
   `declined: "amber"` can never render; and `ChipTone` (`src/notifications/assemble.ts:101`) has
   no `red`, so design call #5's red Declined pill is approximated by amber in the map. Dead code,
   harmless, but it will mislead anyone who later widens the query.
6. **The unassigned half is not window-scoped**, so an unclaimed ticket reappears in every daily
   digest until someone picks it up. This is what §6 specifies ("org-wide, newest first", no window)
   and matches `review_queue`'s state-not-log posture; noted only so the repetition is not later
   read as a bug.
7. **Three test files outside the new one changed** (`registry` ×1 case, `routes` ×2 assertions).
   All are list-of-kinds expectations that a fourth kind necessarily moves; no production behavior
   was adjusted to make a test pass.
8. **Line numbers in the implementer's phase report drift slightly** from the committed file (it
   cites `:80,105` for title escaping — actually `:84,110`; `:87/:113` for the cap — actually
   `:78,96,101`; `:137-145` for the kind — actually `:137-144`, the file is 144 lines). The
   substance is accurate; the numbers above are the verified ones.

**Verdict: ACCEPT.** The kind's id, label, description, defaults and allowed cadences are exactly
§6's; the renderer is a provable pure read that returns null on an empty queue, lists unassigned
`submitted` tickets then the recipient's own open assigned ones through the very function My Work
uses, escapes every interpolated string, ships a text alternative and deep-links `/#tickets`;
nothing in the ticket, sprint, route or webhook paths reaches into `src/notifications/`, so there is
no per-event mail; the registry line alone carries the kind into policy seeding, the Maintenance
policy list, the Settings prefs list and a run's `kinds`, each proved against the real cookie-gated
routes and real outbox/body rows; the idempotency key, the second-run no-op and the all-null
`skipped`-with-no-body case are all pinned; the suite, typecheck and web build are green but for the
accepted environmental failure; and four of five reverts each turned a specific named assertion red
and restored green.

---

## Final review and fix pass (commit 3c9aa9e)

Independent re-verification of the fix pass that answered the whole-branch final review
(`.superpowers/sdd/2026-09-16-canopy-tickets/final-review.md`: 1 Critical, 4 Important, 13 Minor, a
CLAUDE.md accuracy checklist and eight deferred items). Range `0a129e8..3c9aa9e` — 23 files,
+581/−127. The verifier did not write the code and edited nothing but this file.

### Delivered

**1. CRITICAL — chunked id fan-out (D1's 100-bound-parameter ceiling; review findings 1 + 14)**
- `src/db.ts:35-70` — the one helper, next to `first`/`all`/`run`: `ph(n)` (`:35`, moved up from the two
  private copies in `reads.ts`/`sprints.ts`), `ID_CHUNK = 80` (`:38`), `chunked()` (`:41`), and
  `fanOut()` (`:54`), which runs the statement once per chunk and concatenates; `leading` params bind
  BEFORE the ids so a statement with params ahead of the `IN (…)` still works.
- `src/tools/reads.ts:234`, `:239`, `:244`, `:251` — `list_tickets`' four fan-outs (assignees, link
  counts, sub counts, sprint labels). The old `if (keys.length)` guards fell away because `fanOut` on an
  empty list issues no query at all.
- `src/tools/reads.ts:569`, `:570`, `:581`, `:584`, `:588`, `:597` — `query()` hydration (docs, staged
  `doc_versions`, feed, ADRs, tickets, sprints); review finding 14 folded in, `fetchCap` reaches 150.
- `src/tools/sprints.ts:100` — `ticketCountsBySprint`'s scoped call, the two status params passed as
  `leading`; `:231` — `get_sprint`'s new per-ticket assignee query; `:260` — its `ticket_links` query.
- No `LIMIT` was added to `GET /tickets` — the review's explicit non-fix (it would silently truncate the
  queue, and the brief has no pagination).
- Merge correctness: every chunked statement is keyed or grouped by the id that was chunked
  (`ticket_id` / `parent_id` / `sprint_id` / `slug` / `id`), so each row lands in exactly one chunk and
  the `GROUP BY` counts and the per-key `ORDER BY` inside a chunk are complete.
- Grep for surviving `.map(() => "?")`-style builders: only `src/tools/reads.ts:52` (the feed `tags`
  filter), `src/tools/mywork.ts:215` and `src/notifications/renderers/my-work.ts:70` (a person's GitHub
  logins) and `src/tools/progress.ts:104` (a milestone's issue numbers) — all pre-existing, none an
  unbounded row-id list.
- Tests: `test/tickets.routes.test.ts:682-731` — 130 tickets seeded in one `env.DB.batch`, then
  `GET /tickets?seg=all` returns 130 rows with the assignee / link_count / sub_count / sprint_label of
  the row that sorts LAST (`:706-712`) and an empty first-chunk row (`:714-716`); `:724-730` pins
  `seg=open`. `test/sprints.routes.test.ts:481-511` — 130 tickets in one sprint through
  `GET /sprints/:id`: 130 rows, progress `130 total`, `tickets[129].assignees`, resources, members, and
  a still-empty first-chunk row.

**2. IMPORTANT — `write_plan` preserves omitted sprint fields, an explicit null still clears (finding 2)**
- `src/tools/plan.ts:76-92` — the UPDATE is built from what the caller actually supplied:
  `title` / `target_date` / `status` / `updated_at` always (they are required on `PlanSprintInput`);
  each of `description`, `summary`, `phase`, `dates`, `urgency`, `lead`, `domain`, `github_ref` appended
  only when it is not `undefined`. Column names are literals, never input. The INSERT arm is unchanged,
  so a NEW sprint still defaults `urgency` to `'normal'`.
- `urgency` can never arrive as `null`: `PlanSprintInput.urgency` (`src/tools/plan.ts:20`) and the MCP
  zod arg (`src/mcp.ts:222`) are `.optional()` but NOT `.nullable()`, so the NOT NULL column is safe
  under the dynamic SET list. (This is why `COALESCE(?, col)` was correctly rejected — it cannot tell
  "omitted" from "explicitly null", and the review required null to keep clearing.)
- Doc: `plugins/canopy/skills/update-plan/SKILL.md:87-89` states the omit/null rule under §3.
- Tests: `test/plan.test.ts:86-124` (the full panel shape, then `write_plan({id, label, due, status})` —
  required fields overwrite, all eight optional ones survive) and `:126-160` (`summary`/`lead`/`domain`/
  `github_ref` passed as explicit `null` clear, while `description`/`phase`/`dates`/`urgency` omitted in
  the same call survive).

**3. IMPORTANT — unknown `sprint_id` folds into BACKLOG, plus a sprints-error hint (finding 3)**
- `web/src/tickets.ts:219` — `const known = new Set(sprints.map((sp) => sp.id))`; `:232` — BACKLOG takes
  `t.sprint_id === null || !known.has(t.sprint_id)`, so nothing is ever dropped from the table while the
  footer still counts it.
- `web/src/render.ts:1615` — `ticketsScreen` prepends
  `mwDegradedHint("Couldn't load sprints — grouping by sprint is unavailable.")` when
  `s.sprints.status === "error"`, and STILL renders the queue.
- Tests: `test/render.tickets.test.ts:213-230` (the hint appears, the orphaned ticket renders, BACKLOG is
  there; a healthy slice says nothing), `:308-317` (`queueGroups` with an empty sprint list keeps all
  four ids and the footer reads `4 shown · 0 unassigned`), `:319-325` (the same fold when other sprints
  did load).

**4. IMPORTANT — `applyTicketWrite` sequence guard (finding 4)**
- `web/src/main.ts:678` — `claimTicketDetail()` = `++ticketDetailSeq`, the SAME module counter
  `loadTicketDetail` uses (`:589`, `:591`, `:597`, `:600`); `:684` — `applyTicketWrite` adopts the
  response only while `seq === ticketDetailSeq`. Badge refresh, queue refetch and the toast still run
  either way — the write did succeed; only the screen adoption is guarded.
- **Every ticket write call site is covered — counted, not assumed.** Seven writes in `dispatch`, each
  claiming before the request goes out: `:1087` (transition), `:1100` (assignee add), `:1107` (assignee
  remove), `:1118` (sprint set), `:1129` (parent set), `:1141` (link add), `:1158` (comment) — matching
  exactly the seven `applyTicketWrite` calls at `:1088`, `:1101`, `:1108`, `:1120`, `:1131`, `:1148`,
  `:1160`. `grep -c` on both names returns 7 and 7 (plus the declaration and its doc comment); there is
  no unguarded call.
- No revert check and no test — by design, see Gaps. `npm run typecheck` is the mechanical cover: `seq`
  is a required third parameter, so an un-updated call site cannot compile.

**5. IMPORTANT — `COLLATE NOCASE` on the assignee match (finding 5)**
- `src/tools/mywork.ts:164` — `JOIN ticket_assignees a ON a.ticket_id = t.id AND a.login = ? COLLATE NOCASE`;
  `:204` — `listAssignedTickets(db, me.handle)`, the canonical handle from `getPerson`, not the raw
  caller string.
- `src/tools/reads.ts:217` — the same on `assignee=me`'s `EXISTS` clause.
- The review's third site, `src/notifications/renderers/ticket-queue.ts:71`, calls `listAssignedTickets`,
  so it is fixed transitively; the renderer's own unassigned query (`:56`) compares no login.
- Test: `test/mywork.test.ts:381-394` — seed `CaseyQ`, file a ticket assigned to `CaseyQ`, then
  `getMyWork(db, "caseyq")` returns `person: "Casey Quinn"` AND the ticket.

**6. CLAUDE.md accuracy — the review's checklist re-run line by line against the code**
- `CLAUDE.md:177-179` ("a sprint is completed by a PERSON: `POST /sprints/:id/complete` sits under the
  blanket `sessionGate` with no `adminGate`") — **TRUE**. `adminGate` is declared at `src/routes.ts:236`
  and applied only at `:238-239` (`/invites`, `/invites/*`); the complete route is `src/routes.ts:532`,
  under `app.use("*", sessionGate)` at `:40`. The route was NOT changed (it is byte-identical to
  `2b1f102`) — the doc was corrected to match, which matches the ledger ruling.
- `CLAUDE.md:252-257` (three My Work lists) — **TRUE**: `shared/dashboard.ts:57-59` declares
  `previousActivity`, `todo` and `tickets`.
- `CLAUDE.md:258-261` (a Google-only person still gets tickets) — **TRUE**: `src/tools/mywork.ts:204`
  reads the tickets before the identity fork at `:206-207`; pinned by `test/mywork.test.ts:396`.
- `CLAUDE.md:130-131` (`canTransition` in `shared/tickets-core.ts`, re-exported by `shared/tickets.ts`) —
  **TRUE**: declared `shared/tickets-core.ts:41`, re-exported `shared/tickets.ts:22`.
- `CLAUDE.md:170-171` ("routes in `src/routes.ts` over the writers in `src/tools/sprints.ts`") —
  **TRUE**: the six sprint routes are `src/routes.ts:480`, `:489`, `:491`, `:501`, `:517`, `:532`.
- `CLAUDE.md:49-56` (the `shared/` bullet) — **TRUE**: it now names `contract.ts`, `vocabulary.ts`,
  `rows.ts`, `dashboard.ts`, `notifications.ts`, `tickets.ts`, `sprints.ts`, `tickets-core.ts`,
  `sprints-core.ts`, which is exactly `ls shared/`. The stated `*-core.ts` rule is real:
  `shared/tickets-core.ts:19-58` and `shared/sprints-core.ts:14-22` hold the value exports.
- `CLAUDE.md:81-86` (the `web/` bullet) — **TRUE**: the four new screens are in the `Screen` union
  (`web/src/render.ts:31-35`: `tickets` / `ticketdetail` / `newticket` / `sprint`), and
  `web/src/tickets.ts`, `web/src/sprints.ts` and `web/src/hash.ts` all exist with the named exports
  (`parseHash` `:38`, `hashForRoute` `:66`, `#tickets/<id>` `:67`, `#sprints/<id>` `:69`); the sprint
  description does go through `renderMarkdown` (`web/src/sprints.ts:349`).
- Every other CLAUDE.md line is byte-identical to `0a129e8`. One residual inaccuracy in a changed
  paragraph is listed under Gaps.

**7. Deferred items (a)–(e)**
- **(a) Roadmap sort key pinned.** `test/roadmap.test.ts:109-123` — three sprints (`''`, `2026-12-01`,
  `2026-10-01`) through `GET /roadmap`: order `Sooner, Later, Unscheduled`, and the blank surfaces as
  `due: null`. Covers `SPRINT_ORDER` at `src/tools/sprints.ts:144`.
- **(b) `ticketq` canned sample.** `src/notifications/sample.ts:25-39` (the `unassigned()`/`assigned()`
  card helpers mirroring `renderers/ticket-queue.ts`'s two halves) + `:86-104` (the fourth Section,
  "Ticket queue", `/#tickets`, UNASSIGNED ×2 + ASSIGNED TO YOU ×1, with its text alternative).
  Test: `test/notifications.preview.test.ts:60-65` asserts `&sample=1` previews all four sections.
- **(c) Sprint-screen assignee avatars (design 514).** `shared/sprints.ts:120` — `SprintTicketRow` gains
  `assignees: string[]`; `src/tools/sprints.ts:229-243` fills it with ONE grouped, chunked query (no
  per-row lookup); `web/src/sprints.ts:288` renders `avatarStack(t.assignees, persons, 18)` between the
  title and the chips. Tests: `test/render.sprints.test.ts:388-405` (exact `avatarStack` output, the
  `-7px` overlap, and none of it on an unassigned row) and `test/sprints.routes.test.ts:504` (server
  side, on a row past chunk one).
- **(d) `ticketq` TOP cap pinned.** `test/notifications.ticketq.test.ts:149-162` — 6 unassigned tickets,
  the 5 newest render, the oldest does not, and `+1 more waiting in Tickets` appears in both HTML and
  text with exactly 5 `unassigned` text lines. Covers `TOP = 5` at
  `src/notifications/renderers/ticket-queue.ts:10` / `:78` / `:96` / `:101`.
- **(e) Needs-attention rows keep their hover background.** `web/src/tickets.ts:118` — the inline
  `NEEDS_ATTENTION_STYLE` keeps only `box-shadow:inset 2px 0 0 var(--accent);`; the faint fill moved to
  `.cnpy-attn` (`web/src/canopy.css:89`), applied at `web/src/tickets.ts:192` (table row) and `:267`
  (board card). `.cnpy-trow:hover` (0-2-0) now outranks `.cnpy-attn` (0-1-0) with no `!important`. The
  existing inline-rule assertions (`test/render.tickets.test.ts:340`, `:346`) stay green.

**Invariants, re-checked on the fix diff only.** `git diff --name-only 0a129e8..3c9aa9e` touches no
`src/routes.ts`, `src/mcp.ts`, `src/consumer.ts` or `src/webhook.ts`. Grepping every ADDED line under
`src/`, `shared/` and `web/` for `app.get|app.post|app.put|app.delete|server.tool|registerTool|consume(|ingest[A-Z]|'done'|"done"|'declined'|"declined"`
returns nothing. **No new route, no MCP write tool, no gate call, no status inference.**

### Commands

```
$ npm test
 Test Files  1 failed | 91 passed (92)
      Tests  1 failed | 969 passed (970)
   Start at  07:53:54
   Duration  31.07s (transform 14.58s, setup 347.95s, import 19.05s, tests 13.21s, environment 6ms)

 FAIL  test/summarize.test.ts > webhook → summarize wiring > with no explicit summarizer and
       GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws,
       never hits the network)
AssertionError: expected 'gemini-2.5-flash-lite' to be 'excerpt' // Object.is equality
 ❯ test/summarize.test.ts:197:27
        ← the accepted environmental failure, nothing else

$ npm run typecheck
> tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json
(no diagnostics, exit 0)

$ npm run build:web
vite v6.4.3 building for production...
✓ 26 modules transformed.
dist/index.html                   0.75 kB │ gzip:  0.39 kB
dist/assets/index-moAs7XmT.css   13.67 kB │ gzip:  3.51 kB
dist/assets/index-_x-EpGDa.js   304.84 kB │ gzip: 83.53 kB
✓ built in 368ms
(exit 0)

$ git status --porcelain
?? canopy-tickets-audit.md
?? docs/superpowers/plans/2026-06-29-record-session-mcp-tool.md
?? docs/superpowers/plans/2026-07-03-feed-docs-triage-audit-results.md
?? docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md
        ← this audit plus the three pre-existing untracked plan docs; nothing else, and every
          scratch revert below was restored before the run

$ git diff --stat 0a129e8..3c9aa9e -- migrations docs "Canopy Frontend Design System" .claude
(empty — the fix pass touched no migration, no doc under docs/, not the locked design,
 not the parked worktree)

$ grep -rn 'map(() => "?")' src shared web/src
src/tools/reads.ts:52                          (feed tag filter — pre-existing, not a row-id list)
src/tools/mywork.ts:215                        (a person's github logins — pre-existing, bounded)
src/notifications/renderers/my-work.ts:70      (same)
        ← no id-list placeholder builder survives in reads.ts / sprints.ts
```

### Revert checks

Eight reverts, one per delivered item that is testable. Each was applied to the working tree, the named
suite run, then restored with `git checkout` (final `git status` above proves the tree is clean).

- **Chunked fan-out** — `src/db.ts:38` `ID_CHUNK = 80` → `Infinity` (one chunk, i.e. the pre-fix shape).
  `npx vitest run test/tickets.routes.test.ts test/sprints.routes.test.ts` → **3 failed | 59 passed
  (62)**, every one raising `Error: D1_ERROR: too many SQL variables at offset 366: SQLITE_ERROR`:
  `GET /tickets past 100 rows > returns all 130 rows…`, `> holds for a filtered segment too — seg=open…`,
  and `GET /sprints/:id past 100 tickets > returns all 130 tickets…`. Restored → green.
- **`write_plan` preserve** — `git checkout 0a129e8 -- src/tools/plan.ts` (the full-replacement UPDATE).
  `npx vitest run test/plan.test.ts` → **2 failed | 10 passed (12)**: `test/plan.test.ts:86`
  `AssertionError: expected null to be 'goal line'` and `:126` `expected null to be 'desc'`. Restored →
  green.
- **BACKLOG fold + sprints-error hint** — `web/src/tickets.ts:232` back to `t.sprint_id === null` and
  `web/src/render.ts:1615` `hint` back to `""`. `npx vitest run test/render.tickets.test.ts` →
  **3 failed | 64 passed (67)**: `expected '<div data-cnpy-theme…' to contain 'Couldn\'t load sprints'`,
  `expected [ 3 ] to deeply equal [ 1, 2, 3, 7 ]`, `expected [ 3 ] to deeply equal [ 3, 7 ]`. Restored →
  green.
- **NOCASE assignee** — `git checkout 0a129e8 -- src/tools/mywork.ts` (drops both the `COLLATE NOCASE`
  and `me.handle`). `npx vitest run test/mywork.test.ts` → **1 failed | 16 passed (17)**:
  `test/mywork.test.ts:381` `AssertionError: expected [] to deeply equal [ 'Cased' ]` — i.e.
  `getMyWork("caseyq")` returns no tickets. Restored → green.
- **(a) Roadmap sort key** — `src/tools/sprints.ts:144` `SPRINT_ORDER` → `ORDER BY target_date ASC, id ASC`.
  `npx vitest run test/roadmap.test.ts` → **1 failed | 13 passed (14)**:
  `expected [ 'Unscheduled', 'Sooner', 'Later' ] to deeply equal [ 'Sooner', 'Later', 'Unscheduled' ]`.
  Restored → green.
- **(b) `ticketq` sample** — `git checkout 0a129e8 -- src/notifications/sample.ts`.
  `npx vitest run test/notifications.preview.test.ts` → **1 failed | 8 passed (9)**:
  `expected '<!DOCTYPE html><html lang="en"><head>…' to contain 'Ticket queue'`. Restored → green.
- **(c) Sprint-row avatars** — deleted `web/src/sprints.ts:288` (the `avatarStack` line).
  `npx vitest run test/render.sprints.test.ts` → **1 failed | 37 passed (38)**:
  `test/render.sprints.test.ts:388` `expected 'data-arg="10" class="cnpy-trow" style…' to contain
  '<div style="display:flex;flex:none"><…'`. Restored → green.
- **(d) `ticketq` TOP cap** — `src/notifications/renderers/ticket-queue.ts:10` `TOP = 5` → `50`.
  `npx vitest run test/notifications.ticketq.test.ts` → **1 failed | 12 passed (13)**:
  `expected '<div style="font-family:\'Geist Mono…' not to contain 'Unassigned 1<'`. Restored → green.

No revert check for the `applyTicketWrite` guard — see the first Gap.

### Gaps / deviations

- **The `applyTicketWrite` sequence guard is untestable in the current harness.**
  `web/src/main.ts` touches `document` at module scope, so no test imports it (the two tests that reach
  into the SPA's imperative half import `web/src/maintenance.ts`). Extracting the comparison would
  assert `a === b` and prove nothing about the interleaving that is the whole bug. Verified instead by
  reading every call site and counting: 7 `claimTicketDetail()` claims vs 7 `applyTicketWrite(…, seq)`
  applications, one-to-one — plus `npm run typecheck` (the third parameter is required, so an
  un-updated call site would not compile) and `npm run build:web`. Accepted as the implementer framed
  it, recorded here so it is not mistaken for coverage.
- **`CLAUDE.md:255-256` says the `tickets` list is "5 most recently updated"; the code returns 6**
  (`TICKET_LIMIT = 6`, `src/tools/mywork.ts:17`). Doc-only, off by one, and inherited: the same sentence
  has said "5 most recent" about `previousActivity` and `todo` since before this branch
  (`2b1f102:CLAUDE.md:201`) while `PR_LIMIT`/`TODO_LIMIT` have been 6 the whole time. The fix pass
  extended the existing wrong number to the new clause rather than introducing a new error. Not a merge
  blocker; fix all three numbers in one edit whenever CLAUDE.md is next touched.
- **`assignee=me`'s `COLLATE NOCASE` (`src/tools/reads.ts:217`) has no direct test.** The new case test
  covers `listAssignedTickets` only; the `GET /tickets?assignee=me` cases
  (`test/tickets.routes.test.ts:190`, `:200`) use canonically-cased cookies. Verified by reading; latent
  anyway, since `sessions.person` stores the canonical handle.
- **Parked Minors from `final-review.md`** (deliberately not fixed in this pass; no invariant-bearing
  behavior in any of them):
  - Minor 6 — the sprint-resource toast names the wrong resource (`web/src/main.ts:1009` compares the
    raw input against the stored parsed url): **parked** — toast copy only; the stored row is correct.
  - Minor 7 — `applyRoute` does not clear ticket drafts or popover state (`web/src/main.ts:172`):
    **parked** — the app uses `history.replaceState`, so there is almost no back-stack, and
    `openTicket`/`openSprint` already reset on every in-app entry.
  - Minor 8 — `create_ticket` writes four statements with no `db.batch()` (`src/tools/tickets.ts:80`):
    **parked** — every input is validated before the first insert, so a partial write needs a D1 failure
    mid-sequence.
  - Minor 9 — no size or count caps on ticket/sprint payloads (`shared/tickets.ts:124`,
    `shared/sprints.ts:137-147`): **parked** — reachable only by a signed-in org member, and the brief
    specifies no caps.
  - Minor 10 — `ticketId()`/`sprintId()` accept `0`, negatives and exponent notation
    (`src/routes.ts:313`, `:473`): **parked** — they 404 either way; only the strictness disagrees with
    `web/src/hash.ts:31-35`.
  - Minor 11 — `diffSprints` ignores the five new sprint fields
    (`src/notifications/renderers/roadmap-plan.ts:19`): **parked** — a digest omission, not data loss,
    now that item 2 removed the silent wipe it compounded.
  - Minor 12 — the `plan_versions` snapshot order is not `SPRINT_ORDER` (`src/tools/plan.ts:119` vs
    `src/tools/sprints.ts:144`): **parked** — affects only the digest's "order changed" line, never a
    read surface.
  - Minor 13 — four independent spellings of the open-status set (`src/tools/reads.ts:188`, `:316`,
    `src/tools/mywork.ts:166`, `src/notifications/renderers/ticket-queue.ts:56`): **parked** — all SQL,
    so none can import `isOpenStatus`; they agree today.
  - Minor 15 — `get_my_work`'s MCP description still advertises two lists (`src/mcp.ts:179`):
    **parked** — description only; the tool returns `tickets` regardless.
  - Minor 16 — dead `done`/`declined` entries and an amber-for-red approximation in the email status map
    (`src/notifications/renderers/ticket-queue.ts:16`): **parked** — unreachable today (the query
    filters to open), misleading only to whoever widens it.
  - Minor 17 — `roadmapNarrative()` renders the Timeline tab under a "Narrative" eyebrow
    (`web/src/render.ts:871` function, `:897` eyebrow): **parked** — both the name and the string are
    pre-existing (`2b1f102:web/src/render.ts:807`).
  - Minor 18 — `TicketCreate`/`SprintCreate` exported as `z.infer` rather than `z.input`
    (`shared/tickets.ts:136`, `shared/sprints.ts:153`): **parked** — the client type is stricter than
    the contract, so nothing breaks.
- **Of the review's eight deferred items, five were taken here ((a)–(e)).** The other three stay parked
  for the reasons the review gave: `/sprints/:id/complete` answering a flat 400 where siblings answer
  404/409 (pre-existing and byte-identical to `2b1f102`); the deliberate description-regex coupling in
  `test/mcp.tickets.test.ts:178-186`; and the repeated open-status spelling (= Minor 13 above).
