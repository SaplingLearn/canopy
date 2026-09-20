# CLAUDE.md

Canopy — a shared context store backend. **One** Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, a GitHub webhook receiver at `/webhook/github`, and the static web
build (via the assets binding); a `scheduled()` cron recomputes roadmap progress. Agents propose context
through a reconciling gate and humans confirm the consequential changes; authored (plan) and computed
(progress, summary) writes go direct.

## Working memory (use the skills)

Canopy is the team's working memory, and the skills under `.claude/skills/` are **the root of how it
stays living** (orient → work → record), not a side feature. The core loop is three skills:

- **`canopy`** — the umbrella/overview skill: the whole loop, the authority model, and the read/write
  tool map (the plan model; no `focus`, no agent-proposed sprints). Its `references/querying.md` is the full
  `query` parameter reference (filtering, browse, pointers, `include_staged`). Start here.
- **`load-context`** (auto-fires, read-only) — **orient before touching an existing area**: it calls
  `query` (assembled authoritative bodies + ranked pointers, each authority-flagged) so you build on what
  exists instead of guessing, and at session start also calls `get_my_work`. ALWAYS run it before
  proposing a doc change (note the doc's `current_version` as the writer's base).
- **`record-session`** (explicit only — never auto-fires) — at **session end**, observe what actually
  shipped (`git`/`gh`), read the touched docs back from Canopy, and stage **one** reconciled batch via
  the `record_session` MCP tool (feed / doc / ADR / triage / event items — a bearer-reachable batch over
  the same gate as `/ingest`).

**Tickets from Claude Code** — **`tickets`** (explicit only, never auto-fires) works the ticket queue and,
for an admin, the sprints, over the scoped MCP write tools. It orients with a read, checks the lane before
proposing anything, shows a one-line diff, then makes ONE call and reports the real new state. Per-team
defaults live in a `tickets.config.md` it reads (`references/config.md`) — advisory taste on top of the
Worker's hard rules, never a permission system. Reading the queue needs no skill.

Three more skills cover the roadmap/my-work surfaces:

- **`read-plan`** (admin, read-only) — read the current plan and check it against captured reality.
- **`update-plan`** (admin, explicit) — push a reshaped plan back through the direct, non-destructively
  versioned plan-write path (`update_plan`), including setting a sprint `done`.
- **`my-work`** (read-only) — pull your own My Work projection (`get_my_work`); also invoked by
  `load-context` at session start.

Trust `live` results; **scrutinize `staged_pending` / `unpromoted` / `draft`** — anything not `live` is
not-yet-settled and must not be treated as established fact. Agents only ever stage; a human confirms in
Triage. That staging-plus-confirmation loop is what keeps the store trustworthy as it grows.

## Commands

- `npm test` — Vitest against a real Miniflare D1 (the source of truth for "is it green").
- `npm run typecheck` — `tsc` over worker + web (does NOT run in `npm test`; run it too).
- `npm run build:web` — Vite build of the web SPA into `web/dist`.
- `npm run dev` — build web, then `wrangler dev`. `npm run deploy` — build web, then `wrangler deploy`.
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations.
- Run one test file: `npx vitest run test/<file>.test.ts`.

## Layout

- `shared/` — the ONLY shared layer (imported via the `@shared` alias by `src/` and `web/`):
  `contract.ts` (Zod ingest contract), `vocabulary.ts` (controlled vocab), `rows.ts` (one type per D1 table),
  `dashboard.ts` (the My Work DTO shared by the Worker and web), `repo.ts` (the Repo dashboard DTO — zod-free,
  since the SPA imports `REPO_TABS` as a value), `notifications.ts` (the digest DTOs), and the
  tickets pair-per-domain: `tickets.ts` / `sprints.ts` (zod rows, DTOs, payloads, `parseTicketLink`,
  `toSprintView`) over `tickets-core.ts` / `sprints-core.ts`. **The `*-core.ts` split is a rule**: anything
  the SPA imports as a VALUE (`canTransition` / `legalMoves` / `TICKET_STATUS_LABEL` / `isOpenStatus`,
  the status/urgency/domain tuples) lives in the zod-free core so the browser bundle never drags zod in;
  the zod module re-exports it, so the server still has one definition.
- `src/` — the Worker. `index.ts` (fetch entry: `/mcp` by bearer, `/webhook/github` by HMAC, everything
  else to the Hono app; plus the `scheduled()` progress backstop), `routes.ts` (Hono HTTP), `mcp.ts` (MCP
  tools), `consumer.ts` (THE GATE), `webhook.ts` (GitHub event capture), `tools/` (`writes.ts`, `reads.ts`,
  `plan.ts`, `tickets.ts`, `sprints.ts`, `mywork.ts`, `repo.ts`, `progress.ts`, `summarize.ts`), `notifications/` (email digests — see the
  Email notifications section), `db.ts` (D1 helpers), `auth/` (`persons.ts` — the identity root;
  `google.ts` — second provider; `onboard.ts` — the sign-in fork + onboarding cookie; `invites.ts`),
  `env.ts`. `repo/` is the repo-capture package behind `tools/repo.ts`: `types.ts` (the `RepoEvent` /
  `RepoEventRow` / `RepoMetric` shapes), `config.ts` (parses the `REPO_ENVIRONMENTS` var into
  `RepoEnvConfig[]`, `[]` on absent/malformed), `capture.ts` (PURE delivery→`RepoEvent[]` derivation,
  `repoEventsFromDelivery` — no DB, no clock, no network, and stores only a SLICE of each payload in `raw`),
  `store.ts` (snapshot/metric upserts plus `pruneRepoCapture` — 45-day retention for high-frequency `check`
  rows and matching metrics, deliberately NOT covering `pr`/`push`; nothing calls it yet, it is wired for the
  Phase 3 cron), `reads.ts` (every SELECT over the capture tables — D1 only, nothing here may fetch,
  including `recordingSince`, the earliest `recorded_at` per kind that the week-over-week deltas below gate
  on), and `github.ts`
  (service-token GitHub reads — `reconcileRepo`, driven off the admin `/admin/backfill` route, never on the
  render path).
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`, then `0011_fts_recreate`,
  `0012_events_plan` [events / pr_summaries / milestone_progress / people / plan / plan_versions +
  `milestones.phase`], `0013_roadmap_fts`, `0014_drop_focus` [retires `0007_focus`],
  `0015_drop_user_token` [drops `users.github_token`], `0016_identity_tasks`, then
  `0017_issue_summaries` [assigned-issue summaries], `0018_structured_summaries` [structured summary
  columns], `0019_drop_pr_summary` [retires the legacy prose `pr_summaries.summary` — PR cards are
  structured-only], `0020_docs_space_vocab`, then `0021_notifications` [notification_policy /
  notification_settings / notification_prefs / notification_outbox + `users.email`,
  `users.email_unsubscribed`], `0022_notification_bodies` [dev-only rendered-message store], then
  `0023_persons` [persons / identities / invites replace users + people; sessions + mcp_tokens repoint
  to persons.handle; bodies table loses its outbox FK], then the tickets build: `0024_tickets`
  [tickets / ticket_assignees / ticket_links / ticket_comments / ticket_events + `tickets_fts`],
  `0025_sprints` [`milestones`→`sprints` in place (+ `dates`, `summary`, `urgency`, `lead`, `domain`),
  `milestone_progress`→`sprint_progress` (`milestone_id`→`sprint_id`), `plan_versions.milestones_json`
  →`sprints_json`, roadmap_fts re-keyed `milestone:<id>`→`sprint:<id>`, new `sprint_resources`, and
  `DROP TABLE milestone_proposals` — the whole agent-proposed-roadmap surface goes with it], then
  `0026_token_hint` [`mcp_tokens.token_hint` — the clear-text label Settings lists a token by], then
  `0027_repo_capture` [`repo_events` (append-only, UNIQUE `semantic_key`, kinds push/pr/review/deploy/check/run)
  / `repo_snapshots` / `repo_metrics` — the Repo dashboard's second capture path, deliberately separate from
  `events`]).
- `web/` — full TypeScript/Vite single-page app (My Work, Feed, Docs, Roadmap, Triage, Search,
  Settings, Get Started, the four tickets screens — Tickets queue / ticket detail / new ticket / sprint —
  the five-tab Repo dashboard, plus the `#unsubscribe` confirmation screen) served via the ASSETS binding;
  `web/src/markdown.ts` renders PR summaries, the roadmap narrative and a sprint description as styled HTML;
  `web/src/notifications.ts` holds the Settings › Email notifications and Maintenance › Notifications views;
  `web/src/tickets.ts` + `web/src/sprints.ts` are the (purely presentational) tickets/sprint components, and
  `web/src/hash.ts` is the hash-route seam (`parseHash` / `hashForRoute` — `#tickets/7`, `#sprints/3`,
  `#repo/<tab>`). `web/src/repo.ts` is the Repo dashboard (ported from the Claude Design `Canopy Repo
  Dashboard.dc.html`), `web/src/repo-sample.ts` its design-placeholder set (a dynamic import, never in the main
  bundle), and `web/src/sidebar.ts` + `web/src/morph.ts` the sidebar — see "Sidebar & motion" below.
  Signed out, the app renders the **landing page** (`web/src/landing.ts`, ported from the Claude Design
  `Canopy Site.dc.html`); its nav's Sign in opens the GitHub/Google dialog, and its in-page links scroll
  rather than set the hash (the hash is the route and the sign-in return-to). Signed IN, the sidebar logo
  reopens the same page as the `site` screen (`#site`): its nav swaps Sign in for "Back to the app", which
  returns to the route the logo was clicked from; `#site` is never stashed as a sign-in return-to. `web/src/landing-motion.ts`
  plays its scroll reveals; played keys live in `state.landingSeen` so a rerender never replays them.
- `.claude/skills/` — Claude Code skills: `canopy`, `load-context`, `record-session`, `tickets`, and the
  roadmap/my-work skills `read-plan`, `update-plan`, `my-work`. Described in the Working memory section
  above. (Symlinks into `plugins/canopy/skills/` — one source of truth.)

## Core invariant — ingested content is gated; authored & computed writes are direct

`consume()` is an **ingestion** gate, not a universal write gate: it polices agent-proposed content
(vocab, confidence, content-hash dedupe, reconciliation). Every ingested entry funnels through the
per-type **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` /
`ingestAdrDraft` / `ingestEvent` / `ingestRepoEvent`). The ingestion entry points are thin
adapters over these: `/ingest` and the MCP `record_session` batch tool (both via `consume`), the
per-entry MCP write tools (`append_feed`, `propose_doc_update`), and the `/webhook/github` branch, which
calls `ingestEvent` (into `events`, for My Work) AND, independently, `ingestRepoEvent` (into `repo_events`,
for the Repo dashboard — see below) off the SAME verified delivery. The gate **reconciles**, not just routes:

- **Replay ledger** (`processed_items`, keyed by `session.id + item_index`): a re-POST of the same
  payload drops every item as `unchanged` — nothing is double-written. MCP tools use an ephemeral
  UUID session so each call is independently reconciled without ever hitting the ledger.
- **Content-hash dedupe** (SHA-256 via Web Crypto): an identical body for an existing slug/ADR
  is a no-op (`unchanged`) unless `force: true` is passed.
- **Change-typing**: `change_kind` (`new` / `edit` / `rewrite`) is server-computed via a line LCS diff
  of the proposed body against the current promoted body; `base_version` records the version the writer
  read, surfacing stale-edit warnings. Both are stored on `doc_versions`.
- **Low-confidence nuance**: low-conf on a NEW slug → triage; low-conf on an EXISTING slug → stage and
  flag (`low_confidence = 1`) for human scrutiny. Only low-conf new slugs go directly to triage.
- Out-of-vocab tag/section → routed to `needs_triage` (nothing is guessed).
- **Events** carry no vocab/confidence — an event is external fact captured verbatim, deduped by a UNIQUE
  `semantic_key` (`gh:pr:42:merged`, `gh:issue:…`) written `INSERT OR IGNORE` (a redelivery/backfill
  overlap drops as `unchanged`). Its `subject_login` is a SECOND identity (who the event is about),
  trusted only post-HMAC — distinct from the writer.
- **Author is ALWAYS the authenticated principal**, passed in by the caller. The client-supplied
  `session.author` is advisory and ignored. (This writer rule does NOT clobber an event's `subject_login`.)
- **Repo capture is a SECOND, sibling gate to `ingestEvent`** — same reconciliation (a UNIQUE `semantic_key`
  written `INSERT OR IGNORE`, so a redelivery or a backfill overlap drops as `unchanged`) but deliberately
  NOT the `events` table: `ingestEvent` raises an `identity_tasks` row per unmapped `subject_login`, which is
  wrong for bots and high-volume CI telemetry (pushes, checks, runs). `ingestRepoEvent` carries no
  vocab/confidence and does no identity intake or summarization; it is reached only from the HMAC-verified
  webhook and the admin-triggered `reconcileRepo` backfill (`src/repo/github.ts`, service-token GitHub reads,
  never on the render path) — never through `/ingest` or `record_session`. `src/webhook.ts`'s
  `WORK_EVENT_NAMES` (`pull_request` / `issues`) and `REPO_EVENT_NAMES` (currently `pull_request` / `push`,
  later phases append) independently gate which deliveries feed which capture; a repo-capture failure is
  caught and logged, never costing the My Work capture, and the webhook's response body carries
  `repo: { captured, unchanged }` alongside the existing `captured` / `unchanged`. PR-close and issue capture
  into `events` is unchanged by any of this.

Authored and computed writes are **direct, in the `promote` class** — NOT the ingestion gate — exactly
like `promote_doc` / `ratify_adr` / `complete_sprint` always have been: the plan write
(`update_plan` → `write_plan`, versioned non-destructively) and the computed writes (the progress cache in
`tools/progress.ts`, the PR summaries in `tools/summarize.ts`). When adding an **ingestion** path
(agent-proposed content), add it to the gate — never a second ingestion surface; authored/computed writes
stay direct in the promote class.

**Tickets are the largest authored-write surface** (`src/tools/tickets.ts`, ten session-cookie routes in
`routes.ts`): `create_ticket` (opening `ticket_events` row) / `transition_ticket` / `toggle_assignee` /
`add_ticket_link` / `set_ticket_sprint` / `set_ticket_parent` / `add_ticket_comment`. There is no vocab
gate, no confidence, no staged state. Every write bumps `tickets.updated_at` (the queue's sort key); the
status machine is `canTransition` in `shared/tickets-core.ts` (re-exported by `shared/tickets.ts`) and is
never re-declared server-side; an illegal move or a nesting-rule break is a 409 that writes nothing;
tickets nest exactly ONE level (`set_ticket_parent`'s four rejections).

**The writer is a PERSON — over a cookie, or over their own bearer token.** Six of those writers are also
MCP tools (`src/tools/tickets-agent.ts`, the read side below), scoped so an agent writes only inside its
principal's lane. That is a narrowing of the old "ticket writes are cookie-only" rule, not of the
invariant underneath it: **nothing INFERS a resolution.** `done` / `declined` are never set by a PR
merging, an issue closing, the webhook, or `scheduled()` — a person asks for them, and an agent holding
that person's token asking is that person asking. `toggle_assignee` is the one writer with NO MCP
counterpart (design D3): assignment is the data the lane rule is built on, so after filing it is
cookie-only, forever.

## Read side — FTS5 query engine

`src/tools/reads.ts` exposes a ranked FTS5 `query()` engine (bm25, title/summary weighted) that backs
both MCP `query` and `GET /search`, over five types: `doc` / `decision` / `feed` / `sprint` / `ticket`. Each
result is authority-flagged: `live` / `staged_pending` / `unpromoted` / `draft`. The doc/feed/ADR index
lives in `migrations/0008_fts.sql` (recreated in `0011_fts_recreate.sql`); `0013_roadmap_fts.sql` adds a
standalone `roadmap_fts` over the plan narrative + sprints (refs `plan` / `sprint:<id>`, re-keyed by
0025) so `query` surfaces the roadmap, and `0024_tickets.sql`'s `tickets_fts` backs the `ticket` type
(ids `ticket:<id>`, always authority `live` — a ticket is an authored human write with no staged state).
`get_doc` is the exact-slug fetch (all versions + live body); `list_tickets` / `get_ticket` /
`ticket_badge` are the queue's read projections (no N+1 — grouped queries keyed by ticket id). The
assembled `sprint` body's `Progress: closed/total` line uses the SAME `sprintProgress` rule as the
Roadmap (tickets + cache), never the cache alone.

**MCP ticket/sprint reads are unscoped; the writes are not** — `src/mcp.ts` registers `list_tickets`
(`seg` / `assignee` where `me` = the bearer principal / `category`), `get_ticket`, `list_sprints` and
`get_sprint` for EVERY principal (not admin-gated): seeing the org's queue is how an agent orients.

**The write surface is `src/tools/tickets-agent.ts` — the ONE place the lane rule is drawn** (spec:
`docs/superpowers/specs/2026-09-17-agent-ticket-writes-design.md`). A ticket write over MCP is permitted
exactly when the bearer principal is ALREADY an assignee of that ticket, else `TicketError('forbidden')`
(403) with NOTHING written; an unknown id is `not_found` FIRST, so the check is never an existence
oracle. Each of the six tools (`create_ticket` / `transition_ticket` / `add_ticket_comment` /
`add_ticket_link` / `set_ticket_sprint` / `set_ticket_parent`) asserts, then delegates to the UNTOUCHED
writer in `tools/tickets.ts` — the transition table, nesting rules and audit rows stay shared with the
cookie routes, which are NOT assignee-scoped and did not change. `create_ticket` is the one unscoped
write (filing is how work enters the queue) and its `assignees` is the only agent-reachable assignment;
`set_ticket_parent` needs the lane on BOTH ids. ONE exception: an **admin** may `set_ticket_sprint` on any
ticket (composing a sprint is sprint management) — it spreads to no other verb. **Sprint writes are
admin-only** (`create_sprint` / `set_sprint_active` / `complete_sprint` / `add_sprint_resource`),
conditionally registered like `update_plan` so a non-admin cannot see them — a deliberate delta from the
web, where `POST /sprints/:id/complete` is open to any member. **No provenance is stored** (design D4): an
MCP write is recorded as the person, indistinguishable from a click.

- **MCP `query`** defaults `include_staged: true` — agents see staged/unpromoted context (authority-flagged).
- **`GET /search`** (human UI) defaults `include_staged: false` — shows only settled (`live`) content.

## Staged-write model — agents stage, humans confirm

Agents only ever stage; humans confirm via **authenticated HTTP routes that are NEVER MCP tools**:

- Docs: `propose_doc_update` stages a `doc_versions` row (status `staged`); `POST /doc/:slug/promote`
  copies it into the live doc and bumps `current_version` (non-destructive; prior versions remain).
  Reject (soft): `POST /doc/:slug/reject` flips a staged version to `status='rejected'`; the row
  and body remain (non-destructive). Idempotent.
- ADRs: `stage_adr` stages a `draft`; `POST /adr/:id/ratify` flips it to `ratified`.
  Reject (soft): `POST /adr/:id/reject` flips a draft to `status='rejected'`; the row remains.
- Sprints: **nothing about a sprint is ever staged.** 0025 dropped `milestone_proposals` and with it
  the whole agent-proposed-roadmap surface — the gate fn, the contract schema, the promote/reject
  routes, and the `"milestone"` triage-assign kind. A sprint is created and edited by the admin plan
  write (`update_plan` → `write_plan`) or by the session-cookie routes in `src/routes.ts` over the writers
  in `src/tools/sprints.ts` —
  `POST /sprints` (created `upcoming`, `phase` `'Unscheduled'`, no `due` → `target_date` `''` which the
  DTO shows as `due: null`), `POST /sprints/:id/active` (`true` → `in_progress`, `false` → `upcoming`;
  on a `done` sprint `false` is a NO-OP and `true` re-opens it), `POST /sprints/:id/resources`, and
  `POST /sprints/:id/complete` which flips status to `done`. All direct promote-class writes; the same four
  are ADMIN-ONLY MCP tools (read side above). `'done'` is NEVER set by the worker and NEVER inferred from issue closure or from every ticket
  in the sprint being resolved — a sprint is completed by a PERSON: `POST /sprints/:id/complete` sits under
  the blanket `sessionGate` with no `adminGate`, so any signed-in org member can do it from the web UI;
  the plan write is the admin path. The
  triage-assign kinds are now exactly `doc` / `adr` / `feed`.
- Triage write-back: `POST /needs-triage/:id/discard` (soft dismiss) and `POST /needs-triage/:id/assign`
  (re-runs the item's `raw` through the SAME gate for the target type, then records `resolution='assigned'`
  with `assigned_ref`). All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.

## Auth — three classes, two providers in the session class (fully built — don't add a class)

GitHub OAuth + PKCE, gated to **active members of the `SaplingLearn` org** (`SAPLING_ORG` in
`src/auth/github.ts` — a real external org, do not rename it). Three auth classes, kept separate:

- **Session cookie** (humans, the Hono app): signed cookie; every route except the public auth paths
  passes `sessionGate`. The principal is `{ handle }`. Two providers feed ONE fork (`src/auth/onboard.ts`
  `completeSignIn`): **GitHub** (OAuth + PKCE, gated to active `SaplingLearn` members) and **Google**
  (OAuth + PKCE, ID token verified against Google's JWKS, gated to admin **invites**). The fork: known
  identity → session; verified email matches a person → link + session; invited (or GitHub member) →
  onboarding (a sealed 10-minute `onboard` cookie; the person row is created only on `POST /auth/onboard`
  with handle + color); else denied. Link mode (`?link=1` with a session) attaches a second provider in
  Settings; the last identity can't be unlinked.
- **Bearer token** (agents, `/mcp`): per-person tokens stored hashed (`canopy_mcp_` prefix); the principal
  is resolved from the bearer. Settings lists a person's live tokens by `token_hint` (the first 4 characters
  of the random part; the value itself is shown once, at mint) via `GET /auth/mcp-tokens`, and
  `POST /auth/mcp-tokens/:id/revoke` soft-revokes the caller's OWN token — someone else's id is the same
  404 as an unknown one. Both are session-cookie routes, never MCP tools. `/mcp` is **bearer-only** — on bad/missing creds it returns a bare `401`
  with NO `WWW-Authenticate` and NO OAuth discovery. A fresh `McpServer` is constructed per request
  (SDK ≥1.26 guards against reuse); `createMcpHandler` is stateless (no Durable Object / McpAgent).
- **GitHub webhook** (`/webhook/github`, `src/webhook.ts`): a delivery authenticates by an HMAC-SHA256
  `X-Hub-Signature-256` over the raw body against `GITHUB_WEBHOOK_SECRET` (NOT `COOKIE_SECRET`). HMAC is
  verified in the branch BEFORE the gate; a bad/absent signature (or unset secret) is a bare `401`. The
  writer principal is the fixed string `"github-webhook"`; the delivery's own `subject_login` is trusted
  only post-verify. This branch never touches `sessionGate`.

## Identity — persons, not logins

`persons` (handle PK; name, color, email) is the root — the handle is chosen at first sign-in, prefilled
with the GitHub login, and renameable from Settings (`renamePerson` rewrites every stored handle
atomically via `HANDLE_COLUMNS`, in one D1 batch with FK checks deferred for the transaction).
`identities(provider, subject) → person` holds the GitHub login and Google `sub`. Event subjects
(`events.subject_login`) resolve to a person through the github identity row at read time
(`resolvePersonForLogin`); an unmapped login raises an `identity_tasks` row and Maintenance › Identity
links it to an existing handle. Mapping a login there calls the same `linkIdentity` as sign-in linking, so
it also grants that GitHub account sign-in as the mapped person, not just attribution — there is no undo
route yet; fix a wrong mapping by deleting the `identities` row with `wrangler d1 execute`. `ADMIN_LOGINS`
holds handles — list the new handle there before an admin renames (`POST /auth/me/handle` 403s otherwise).
Every `recorded_by` / `created_by` / `user_id` is a handle. Migrated GitHub users kept their login as handle.

## Roadmap & My Work — authored plan + stored projections, no live GitHub at render

The roadmap is two layers. **The plan** (narrative + sprints + timeline) is admin-authored via the
`update_plan` MCP tool (`update-plan` skill) → `write_plan`: a direct promote-class write, versioned
non-destructively into `plan` (singleton narrative) + `plan_versions` snapshots (`sprints_json`), over
the `sprints` table. **Sprints ARE the old milestones, renamed in place by 0025** — same rows, same
ids, plus `dates` / `summary` / `urgency` / `lead` / `domain` alongside the pre-existing `description`
(now rendered as markdown) and `phase`. Sprint `done` is admin-set here, never event-inferred.

**Two vocabularies, one seam** (`shared/sprints.ts`): the DB keeps its column names, the DTO speaks the
product's words — `row.title` ↔ `view.label`, `row.target_date` ↔ `view.due`, and `active` is DERIVED
(`status === 'in_progress'`), never stored. `update_plan`'s input and every sprint route body use the
DTO vocabulary; only `src/tools/` speaks columns. `GET /roadmap` and MCP `get_roadmap` read `get_plan`:
narrative + `sprints: SprintView[]` in target-date order, each with `progress: {closed, total, pct}`.
No live GitHub, no per-user token.

**Progress is TICKET-INCLUSIVE**, computed at read time by the ONE function `sprintProgress` in
`src/tools/sprints.ts`: `total` = the tickets in the sprint + `sprint_progress.total`, `closed` = the
tickets a person set `done`/`declined` + `sprint_progress.closed`, `pct` rounded; a sprint with neither
reads `0/0`. The ticket half is a live D1 count; the GitHub half is a stored cache (`sprint_progress`,
keyed `sprint_id`), written as ABSOLUTE `closed`/`total` (so delivery order is irrelevant — the last
write wins) by two direct writers: the webhook (event-derived, on issue events) and the `scheduled()`
cron backstop (`recomputeAllProgress`, `GITHUB_SERVICE_TOKEN`, off the render path). `github_ref` is bare
(a GITHUB milestone number — GitHub's own vocabulary, kept deliberately — OR a JSON array of issue
numbers) resolved against `GITHUB_REPO` — only by those two writers, never at render.

**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events AND over the ticket queue: three separate lists — `previousActivity` (summarized merged/closed PRs
where the person is the subject, 5 most recent), `todo` (their open assigned issues, 5 most recently
updated, each carrying its own stored summary), and `tickets` (their OPEN assigned tickets, 5 most recently
updated, with the sprint label) — built from `events` (+ `pr_summaries`, `issue_summaries`, `persons`,
`identities`) and from `tickets` + `ticket_assignees`, no live GitHub.
`person` resolves via the github `identities` row (`resolvePersonForLogin`, see Identity above); an
unmapped login yields an empty EVENT projection (`degraded:false`) — but the ticket list is read BEFORE the
identity fork and is keyed on the person HANDLE (`COLLATE NOCASE`, like `persons.handle`), so a person with
no GitHub identity at all (a Google-only filer) still gets their tickets; any D1 failure yields empty
`degraded:true` — never a 500. Completed PRs and assigned issues are each summarized ONCE, at capture time
(`tools/summarize.ts`: Google Gemini `gemini-2.5-flash-lite` via `GEMINI_API_KEY` — a REST
`generateContent` call, not a Cloudflare binding — emits one validated JSON object — PR:
title/what/why/impact; issue: title/summary/next_step). On AI failure the **issue**
path writes a deterministic prose excerpt (`issue_summaries.summary`); the **PR** path
is structured-only (the prose `pr_summaries.summary` column was dropped in `0019`), so
its fallback is a content-less marker row (`model='excerpt'`, null structured columns)
that renders a "No summary recorded" placeholder. Stored as columns on `pr_summaries` /
`issue_summaries` and regenerable via Sync (a row is "done" only when
`model != 'excerpt' AND title IS NOT NULL`) — never truth, never generated at render.

**The Repo dashboard** (`GET /repo/dashboard` → `getRepoDashboard` in `src/tools/repo.ts`; screen `#repo`,
`#repo/code|ci|usage|planning`) is the same class of read as My Work: D1-only, session-cookie, never a 500
(a throw yields `emptyRepoDashboard(repo, degraded:true)`), and NOT an MCP tool. Every block travels as a
`RepoSection<T>` = `ok` / `empty` / `not_connected`. What D1 can answer is live — merged/closed PRs, the
week-over-week tiles (open issues/bugs are the LATEST snapshot per issue as of now vs 7 days ago, read with
`json_extract` so issue bodies never leave D1; open tickets are a live count with a net 7-day delta from
`ticket_events` — **shown only until PR capture is complete; it leaves the Overview once `prCaptured` flips**,
replaced by the Open PRs/Awaiting review tiles below), the activity feed, open issues by label, and the
sprint a person marked `active` (the Roadmap's ticket progress) — **plus, from Phase 1's `repo_events`
capture** (`ingestRepoEvent`, see Core invariant above): Open PRs / Awaiting review tiles, a PR list that
includes open PRs with their own head branch (not just the base ref), a Commits tile with a week-over-week
delta, 14 UTC days of COMMIT bars, pushes woven into the activity feed, and P · M · R contributors (pushes ·
merged PRs · reviews this week — `reviews` is `null`, rendered as "—" and excluded from the bar width, until
a `review` row has ever been captured (`hasCaptured(db, 'review')`); no capture path exists yet, so today
that is always).

The never-guess fallback rule now turns on a **completeness marker**, not "any row exists": `prCaptured` =
`getSnapshot(db, 'prs_reconciled') !== null`, a snapshot `reconcileRepo` (`src/repo/github.ts`) writes only
after the open-PR list has been BOTH fetched AND ingested without throwing — a marker, not
`provenance = 'backfill'`, because a repo with zero open PRs would otherwise never earn one. Until it exists,
the Open PRs/Awaiting review tiles and the Code tab's PR stat read as Merged PRs / Closed-unmerged instead of
lying with "Open PRs: 0" off a single webhook delivery, and the PR list stays the merged/closed list read
from `events`; the 14-day bars stay MERGE bars, not commit bars, **until a `push` row exists in the trailing
14-day window** (not "ever", since the bars only look at that window). A week-over-week DELTA is a further,
independent gate on top of `prCaptured`/`pushes.length`: `recordingSince(db, kind)` (`src/repo/reads.ts`,
`MIN(recorded_at)` for that `repo_events` kind) must predate the comparison window, else the delta reads `0`
(the screen already renders `delta: 0` as "—") rather than an artifact of when capture happened to begin —
PR tiles need `recordingSince('pr') <= weekAgo`, the Commits tile needs `recordingSince('push') <=
twoWeeksAgo` (else its `sub` is just `"this week"`, no comparison). Backfilled `push` rows (one synthetic
count-1 row PER COMMIT) are excluded from the activity feed and the contributors' `pushes` tally — a
40-commit backfill would otherwise read as 40 feed lines and P=40 for one person — but still count toward
the Commits tile's totals and the 14-day bars, which read `repo_events` unfiltered by provenance.

**Everything with no capture path is `not_connected`, never guessed** — environments,
drift, health, branches, deploys, CI failures, coverage, bundle, usage, Cloudflare, hosting, TODO counts
(the `UNCAPTURED` object is the auditable list). Adding a capture path = flip one section there to `ok`; the
screen already renders every section's live shape. Phases 2–5 — what lights up each remaining
`not_connected` section (deploys, checks, CI runs, reviews, environments, drift, health, branches, coverage,
bundle, usage, Cloudflare, hosting, TODOs) — are specified in
`docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md`. The capture names a PR's AUTHOR and an
issue's subject, not who merged/closed — so the feed never claims an actor it does not have. "Preview with
sample data" swaps in `repo-sample.ts` client-side (session-only, labelled on screen); it never touches the
Worker.

`POST /admin/backfill` runs `reconcileRepo` **once per Sync, on the FINAL batch only** — the field to check
is `BackfillResult.summaryBudgetExhausted` (`src/tools/backfill.ts`); `isFinalBackfillBatch` is `true` when
it is `false` (the frontend loop's last call). The SPA can re-POST this route up to 10 times per Sync while
the summarizer budget stays exhausted, and `reconcileRepo` redoes ~250 no-op statements on an
already-reconciled repo, so running it on every intermediate batch would waste that work repeatedly for
nothing; the route folds its `{ written, unchanged }` into the JSON response as `repo`, present only when it
actually ran. Still best-effort (`.catch(() => undefined)`) and unable to fail the route.

## Sidebar & motion — the `<aside>` outlives rerenders

`rerender()` swaps the app wholesale, which is fatal for a transition: a width, a rotating chevron or an
opening sub-page list can only animate on an element that SURVIVES the state change. So `web/src/morph.ts`
`paint()` patches the `<aside>` in place and swaps only `<main>` (the seam is `.cnpy-shell`). That only works
because **the sidebar's structure is stable** (`web/src/sidebar.ts`): every label, badge, dot, chevron and
sub-page list is ALWAYS emitted, and collapsed / open / active are attributes and classes that `canopy.css`
animates (`data-collapsed`, `.cnpy-sub[data-open]`, `.is-active`, `data-n="0"` hides a badge). Emitting a
node conditionally there swaps it out from under its own animation — `test/render.sidebar.test.ts` pins the
element tree across every state. `data-keep` marks a script-owned node (the collapsed-rail tooltip) the
patcher leaves alone. A sub-page list the app opened on entry folds again on leaving; one opened by hand
sticks and is what persists (`canopy.navOpen`). Below 900px the rail renders collapsed (`state.narrow`)
without touching the saved preference. Search is the box at the top of the rail (⌘K / Ctrl+K), not a nav row.

Screen entrances are `[data-enter]` (set by `markEnter()` in `main.ts` only when the route changed or the
screen's main read landed — never on a keystroke). `--enter-t` is a NEGATIVE animation-delay, so a rerender
mid-entrance joins the animation where the old DOM left off. Hooks: `.cnpy-rise` + `--i`, `.cnpy-stagger`
(lists), `.repo-bar` / `.repo-fill` / `.repo-spark`, `data-count` (count-up). In-place changes use the
one-shot `pendingFlash`. All of it is off under `prefers-reduced-motion`.

## Email notifications — a read-side projection, never a writer (spec: `docs/superpowers/specs/2026-09-11-canopy-email.md`)

Digests are assembled from D1 and sent via Resend; the pipeline never writes to the store (only to its own
`notification_*` tables). Everything lives in `src/notifications/`:

- **Registry in code, not D1** (`registry.ts` + `shared/notifications.ts`): one `NotificationKind` per digest
  section — `my_work` (event spine: merged PRs in the window + open assigned issues, summarized exactly as My
  Work does), `review_queue` (open Proposals + draft Decisions), `roadmap_plan` (diffs `plan_versions` in the
  window against the last pre-window version; progress rows never surface), `ticketq` (the ticket queue, not
  window-scoped: `submitted` tickets with no assignees org-wide + the recipient's own open assigned tickets via
  `listAssignedTickets`, the same read My Work uses). A renderer is a **pure read**
  (`render(db, login, window)` → `Section | null`; null = nothing to say, dropped). Adding a kind = one entry +
  one renderer; `notification_policy` is seeded from the registry per isolate (`policy.ts`, INSERT OR IGNORE,
  never overwrites).
- **Cadences are `daily` / `weekly` / `off` — there is NO immediate tier.** Resolution (`resolve.ts`): user pref
  → policy `default_cadence` → registry default; `policy.enabled = 0` short-circuits to `off` before the user
  layer. A pref must be in the kind's `allowedCadences` (validated at write time).
- **Runs** (`run.ts`): per eligible user (address on file, `email_unsubscribed = 0`) the outbox row is claimed
  FIRST by `INSERT OR IGNORE` on `user:cadence:window_id` — a conflict skips the user, so a double fire is
  harmless. Then render, drop nulls, `skipped` on zero sections, else one message → `sent` (with `resend_id`)
  or `failed` (with the error). `retry.ts` re-attempts `failed` rows only. Windows (`window.ts`) are computed
  in the org timezone: daily = previous 24h (72h on Monday), weekly = previous 7 days.
- **Cron** (`cron.ts`, `wrangler.toml [triggers]`): two hourly triggers (`0 * * * *` daily candidate,
  `0 * * * SUN,MON` weekly candidate) dispatched by expression in `scheduled()`, gated in code on
  `notification_settings.send_hour` + `timezone` at fire time (static crons cannot read D1 or follow DST).
- **Delivery gate** (`resend.ts`): `NOTIFICATIONS_MODE` absent/`local` → bodies go to the dev-only
  `notification_outbox_bodies` table and Resend is NEVER called; `resend` requires `RESEND_API_KEY` (a config
  error otherwise, never a silent fallback). Headers: `List-Unsubscribe` (mailto + https) and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **Unsubscribe** (`unsubscribe.ts`): `/u/<login.sig>` (HMAC over the login with `COOKIE_SECRET`) is the
  single signed-token exception — handled in `src/index.ts` outside `sessionGate`; POST can ONLY set
  `email_unsubscribed = 1`; GET redirects to the cookie-gated `#unsubscribe` screen. Prefs survive unsubscribe.
- **HTTP** (`routes.ts`, mounted at `/api/notifications`, session-cookie only, NEVER MCP): `prefs` (GET/PUT,
  own row only), admin-only `policy`, `settings`, `outbox`, `persons/:handle`.
- **Address**: seeded at first sign-in, per provider — GitHub from `GET /user/emails` (primary +
  verified; scope `user:email`), Google from the verified `email` claim on the ID token (unverified
  emails are denied before the fork) — both through `recordSignIn`'s `COALESCE(email, …)` write, which
  never overwrites a user/admin-edited value.
- **Invite email** (`src/notifications/invite.ts`): one transactional message per invite/resend through
  `deliveryFor`; not a kind — no cadence, prefs, or window. Outcome lands on `invites.email_*`. No
  `List-Unsubscribe` headers (they are optional on `OutboundMessage` now, omitted for invites).
- **Welcome email** (`src/notifications/welcome.ts`): the second transactional message — sent from
  `POST /auth/onboard` once the person row and session exist, linking Get Started (`/#guide`, where a
  fresh sign-in lands). Also not a kind. It fires THERE and not when someone joins the GitHub org
  because the address comes from the person's OWN OAuth token (`getPrimaryEmail`), which does not
  exist until they sign in — nothing Canopy holds can reach a new org member before that. No outcome
  column and the result is ignored at the call site: `sendWelcome` never throws, and a mailer problem
  must never cost somebody their sign-up. No address from the provider = no mail.
- **Deferred:** the digest's ledger layout (`EMAIL_CARD.item`) has no avatar chips today, so a person's
  color does not appear in email yet. When a chip is added there, take the color from `persons.color`
  via the light hex set documented in §7 of the identity design doc.
- Tests assert on outbox/bodies rows, never mocks (`test/notifications.*.test.ts`, `test/render.notifications.test.ts`).

## Conventions & gotchas

- `shared/vocabulary.ts` MUST match `migrations/0002_seed_vocab.sql` — it's the gate's source of truth.
- D1 helpers live in `src/db.ts` (`first` / `all` / `run` / `nowIso`); writers in `src/tools/writes.ts`.
- Tests use real Miniflare D1; `test/apply-migrations.ts` truncates data tables `beforeEach` via
  `scripts/seed/reset.mjs` (add new tables — `events`, `repo_events`, `repo_snapshots`, `repo_metrics`,
  `pr_summaries`, `sprints`, `sprint_progress`,
  `sprint_resources`, `tickets` + `ticket_*`, `persons`, `identities`, `invites`, `plan`,
  `plan_versions`, `notification_*` — there). That file is also the canonical person seed: the four
  engineers (github identities) plus two Google-only non-engineers, `meilin` / `sanaok`.
  GitHub I/O and the PR summarizer are dependency-injected (`fetchImpl?: typeof fetch`, `summarizer`)
  because the vitest pool exports no fetch/AI mock — stub at the `Response`/`Summarizer` level, never hit
  the network in tests.
- A `GEMINI_API_KEY` in your local `.dev.vars` leaks into the vitest pool and fails ONE summarizer test
  ("GEMINI_API_KEY unset in tests → excerpt"); it is environmental, not a regression.
- **Deferred seams — do NOT activate:** Cloudflare Queue, Vectorize, the GitHub OAuth provider for MCP.
  They exist as `// SEAM:` comments only.

## Env / bindings

Secrets (`wrangler secret put …`; local: `.dev.vars`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` (Google OAuth client id for the second session-class provider — absent →
`/auth/google/login` itself returns 503), `GOOGLE_CLIENT_SECRET` (absent → the login redirect still
happens, but the code exchange fails and `/auth/google/callback` 401s `exchange_failed`), `COOKIE_SECRET`,
`GITHUB_WEBHOOK_SECRET` (HMAC for the webhook — absent → the surface 401s), `GITHUB_SERVICE_TOKEN`
(app-level token for the scheduled progress recompute — absent → `scheduled()` no-ops), `GEMINI_API_KEY`
(Google Gemini key for capture-time PR/issue summaries — absent → the excerpt fallback), `RESEND_API_KEY`
(email delivery; needed only when `NOTIFICATIONS_MODE = "resend"`). Vars
(`[vars]` in `wrangler.toml`): `GITHUB_REPO` (e.g. `SaplingLearn/sapling`), `ADMIN_LOGINS`, `PUBLIC_ORIGIN`
(absolute origin for links inside email), `NOTIFICATIONS_MODE` (`local` default / `resend`),
`REPO_ENVIRONMENTS` (a JSON list, parsed by `src/repo/config.ts`'s `repoEnvironments()` — which branch
deploys to which environment plus its Worker/URLs; absent or malformed → `[]`. Today it encodes two:
**staging** deploys from `main`, **production** from a `production` branch; backend on Railway, frontend on
Cloudflare Workers. Phase 1 reads it only to pick the backfill's default branch (`reconcileRepo`) and passes
it — currently unused — into the webhook's repo capture; the dashboard's `environments` section itself
stays `not_connected` regardless, until a later phase wires it up).
Bindings: `DB`
(D1), `ASSETS` (static). Capture-time summaries call Gemini over REST (`GEMINI_API_KEY`), never at render —
not a Cloudflare binding, so there is no `[ai]` block. `[triggers] crons` drives the progress recompute backstop (`0 */6 * * *`) and the two hourly digest
candidates (see Email notifications).
