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
  `store.ts` (snapshot/metric upserts — including the `prs_reconciled` completeness marker, the
  `env_heads` branch-head snapshot and the Cloudflare poll's `cf_polled` polled-through marker (and
  `putMetric`, the ONE seam that normalises `repo_metrics.at`) — plus
  `pruneRepoCapture`, CALLED by the repo cron's 6-hourly `:30` tick:
  45-day retention for high-frequency `check` rows and matching metrics, deliberately NOT covering `pr`/`push`,
  and the `check` deletion is further gated `part IS NULL` — a FRONTEND deploy record is a `check` row too
  (`part = 'frontend'`) and must be kept forever like `deploy` rows, not aged out with plain CI checks; plus a
  separate 100-day bound on the HOURLY usage metrics — `cf_*` / `rw_*` / `active_users_*` — while
  `coverage` / `bundle_kb` / `todo_count` match neither rule and are kept forever),
  `reads.ts` (every SELECT over the capture tables — D1 only, nothing here may fetch,
  including `recordingSince`, the earliest `recorded_at` per kind that the week-over-week deltas below gate
  on, and the ONE non-decisive-conclusion policy at `foldResult`/`checkState`), `github.ts`
  (service-token GitHub reads — `ghJson` / `ghGraphql` / `reconcileRepo`, driven off the admin
  `/admin/backfill` route AND the repo cron's 6-hourly `:20` tick — never on the render path), `poll.ts`
  (`pingHealth` — a polite `GET` per environment deployable into `repo_metrics`, all targets pinged
  concurrently, every cron tick), and `cron.ts` (`handleRepoCron` — the repo trigger's one dispatcher, ONE
  heavy job per invocation, with the subrequest budget stated at the dispatcher; see the Repo dashboard
  section below).
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
a `review` row has ever been captured (`hasCaptured(db, 'review')`); the `pull_request_review` CAPTURE ARM
exists (`fromReview` in `src/repo/capture.ts`), but nothing feeds it — the webhook is not subscribed to that
event and `reconcileRepo` has no reviews arm — so today that is always).

**Environments, deploy history, check state and CI failures are also live** (Task 10 closes out Phase 2):
`repo_events` kinds `deploy` / `check` / `run` back the environment cards, the per-part dot-strip deploy
history (`deployHistories`), each environment's head-check verdict (`ci` / `ciTone` / `pill` —
HEALTHY/DEGRADED/FAILING/UNKNOWN, plus DOWN from Phase 3's health pings, see below), and the CI-failures
block (`ciFailureRows` + `ciDailyRates`, gated on
`hasCaptured(db, 'run')`). **Each environment ships two deployables**, on two different hosts
(`src/tools/repo.ts`'s `HOSTS`/`PARTS`): **Backend** is a Railway `deployment_status`, matched to an
environment by `deployment.environment` equalling `cfg.railwayEnv`; **Frontend** is the Cloudflare "Workers
Builds" `check_run` — but a Workers Builds check only counts as THAT environment's frontend deploy when
BOTH its name matches `cfg.workerCheck` AND its branch matches `cfg.branch` (`fromCheckRun` in
`src/repo/capture.ts`) — the same check name running on a PR branch is just a check, not a deploy.
`REPO_ENVIRONMENTS` now feeds three places: the webhook capture (`repoEnvironments(env)` passed into
`repoEventsFromDelivery` so a `deployment_status`/`check_run` delivery can be matched to its environment),
the projection (`getRepoDashboard`'s `envs` param), and `reconcileRepo` (which reads it BOTH to name the
GitHub environments the deployments query filters on AND to pick the branches whose head + head checks it
polls — deployments are selected by ENVIRONMENT NAME, only heads and checks are per branch).

**The environment pill is a verdict about CHECKS, with health as an override**: `HEALTHY` needs checks
captured on the branch head, none of them failing, and no failed part. A deploy that landed with NO checks
captured reads `UNKNOWN` (neutral) — it says only that it landed. A failed part is a fact on its own, so
`FAILING` does not wait for checks. `DOWN` (tone `bad`) OUTRANKS everything else — a fresh health ping
(below) saying the environment is unreachable is the headline, whatever the checks say. The `environments`
section being CONNECTED is a separate question, and is not derived from the pill: it is `ok` once any part
has a result, any head check is captured, OR a health ping (up or down) has landed for that environment — a
health ping alone is enough to be CONNECTED but never enough to be `HEALTHY` on its own. **The `deploys`
section's fallback is gated on a SEPARATE, narrower flag** (parts-with-a-result OR head checks captured —
health EXCLUDED): a health ping is not grounds for "No deploys recorded", so `deploys` stays
`not_connected` until deploy capture itself exists, while `environments` goes `ok` off the ping.

**Environment health is a standing 10-minute ping, not event capture**: `handleRepoCron` (`src/repo/cron.ts`)
runs `pingHealth` (`src/repo/poll.ts`) on EVERY tick of the repo cron — a polite `GET` (an 8s
`AbortSignal.timeout`, `redirect: "follow"`, a `canopy-health` user-agent, no retries) against each
environment's TWO deployables (the Cloudflare frontend URL, the Railway backend's `apiUrl + healthPath`),
all of them pinged CONCURRENTLY (`Promise.all` — sequentially, four dead targets would burn 4 × the timeout
before the tick's real work; each target still times itself, so `health_ms` is unaffected). `redirect:
"follow"` + `res.ok` means a redirect that LANDS on a 200 counts as up: it is a reachability check, not a
content check. Written as `health_up` (0/1) and `health_ms` into `repo_metrics`, bucketed to the 10-minute
tick, so a redelivered or double-fired tick is a no-op (`putMetric`'s `INSERT OR IGNORE` on `(metric, env,
part, at)`). **There is exactly ONE `repo_metrics.at` format, enforced at the write seam**: `putMetric`
re-serialises `at` through `toISOString()` and SKIPS an unparseable value — every read of that table
(`latestMetric` / `metricSeries` / `latestHealth`) compares `at` as a raw string and the UNIQUE key
includes it, so two writers spelling the same instant differently would both mis-order and duplicate.
A thrown fetch (timeout, DNS, connection refused) is recorded as down, never an exception out of the cron.
**A health row older than 30 minutes means the cron has stopped** — `getRepoDashboard` treats it as ABSENT,
both for display (the health block lists only fresh rows) and for the pill (a stale "down" cannot drag an
environment to `DOWN`). The `health` section therefore has THREE states, not two: `ok` when any configured
target has a fresh reading, **`empty` when readings exist but every one has aged out** (the pings were set
up and have stopped — the screen says "No fresh health reading — the last ping is over 30 minutes old."),
and `not_connected` only when no reading has EVER landed. The whole read is ONE D1 statement
(`latestHealth` in `src/repo/store.ts`, the latest row per metric/env/part) however many environments are
configured.

**Drift and branches are also live, off two GraphQL/REST sources, never at render**: `computeDrift`
(`src/repo/github.ts`) compares `envs[0]` (the head, e.g. `main`) against `envs[last]` (the base, e.g.
`production`) via TWO `GET /compare/<base>...<head>` calls (GitHub's compare only returns the AHEAD side's
commits, so the BEHIND side needs its own, second compare), groups the ahead commits by the PR that landed
them (a squash merge's trailing `(#123)`) or as a direct push, and stores one `RepoDrift` snapshot the
Overview's drift strip reads back. The PR-title lookup behind those groups fans out in chunks (`fanOut`,
`src/db.ts`) — a compare returns up to 250 commits and D1 caps a statement at 100 bound parameters. The
snapshot's `ahead`/`behind` are GitHub's own TOTALS while `groups` is built from the commits the compare
actually returned, so on a divergence past that 250 cap the strip's HEADER stays truthful and only the
expanded breakdown is partial. It runs off TWO triggers: a push to either configured environment branch
(`src/webhook.ts`, via the never-throwing `refreshDrift` wrapper) and every `reconcileRepo` (backstopping a
repo that never gets such a push, or whose webhook-triggered call failed). `computeBranches` is ONE GraphQL
page of `refs(refPrefix:"refs/heads/")` with a per-ref `compare(headRef:$head)` (up to 100 branches per page,
5 pages max — REST would cost one `/compare` request PER BRANCH; still paging after the 5th, it THROWS
rather than pass off a 500-branch prefix as the whole repo) and stores a `RepoBranches` snapshot
(active/stale counts, and up to 8 rows: the freshest branches plus up to 3 of the stalest-but-unmerged, 14
days untouched = stale — the fresh slice reserves room for what is actually appended, so a repo whose stale
branches are all merged still fills all 8). GraphQL's `Ref.compare` treats THE BRANCH as base and `$head` as head, so
`aheadBy`/`behindBy` arrive INVERTED from the product's meaning — `computeBranches` flips them back on
purpose (verified live against the target repo). It runs only from `reconcileRepo` (no webhook trigger — a
full refs page on every push would be wasteful). Both `computeDrift` and `computeBranches` THROW on failure
so `reconcileRepo`'s `safely` wrapper can name them in `failed` without disturbing the LAST GOOD snapshot
(never clobbered by a failed refresh); their never-throwing wrappers (`refreshDrift` / `refreshBranches`) are
what callers outside that `safely` arm use. Both sections read `not_connected` until their first snapshot
exists, and — like `drift` always has — show a STALE snapshot rather than nothing. **Nothing on screen says
how old one is**: `computedAt` is stored on `repo_snapshots` but never reaches the DTO, so a snapshot from a
Sync that has not run in a week renders exactly like a fresh one. (`branchHeads` reads `computedAt` for
precedence; the render never does.)

**ONE policy for a non-decisive conclusion**, stated at `foldResult` and again at `checkState`
(`src/repo/reads.ts`) and shared by the deploy dots and the PR checks column: `success` = ok;
`failure`/`error`/`timed_out` = fail; `stale`/`action_required`/`cancelled`/`inactive`-without-a-preceding-
success = cancel (abandoned, not failed — `inactive` AFTER a success is just the supersede marker of a
deploy that DID land, which is why `success` is tested first); `neutral`/`skipped` = nothing happened, so
NOT a dot at all, and a pass for the checks icon. The checks column has only pass/fail/run, and "abandoned"
is a statement about a deploy rather than about the code, so the cancel bucket reads there as not-failing.

A branch's "No checks captured" verdict comes from `branchHeads` (`src/repo/reads.ts`), which now reads TWO
sources and takes the newer: that branch's latest captured `push` row, and the **`env_heads` snapshot**
(`{ [branch]: sha }`) `reconcileRepo` writes via `putSnapshot` — so a branch pushed rarely (production)
still has a head for checks to key off. The snapshot wins only when its `computed_at` is newer than that
branch's latest push `occurred_at` (or when no push was ever captured for the branch) — compared as PARSED
instants (`Date.parse`), never as raw ISO strings: `occurred_at` is stored WITHOUT milliseconds while
`computed_at` comes from `toISOString()` WITH them, so within the same UTC second a string compare would
call a genuinely newer snapshot older. It is deliberately a
SNAPSHOT and no longer a synthetic `push` row: a Sync landing between a real push and its webhook delivery
wrote the count-1 row first, and the real count-N push then dropped as `unchanged` — permanently
under-counting commits and losing the push from the feed — while every Sync that saw a new head added a
phantom commit to the totals. Two D1 statements, whatever the branch count. The pre-capture commit backfill
(the stretch BEFORE push capture began) still writes real backfill push rows and is untouched.

**These sections still read `not_connected` (or `empty`) on a fresh deploy**: the webhook is not yet
subscribed to `deployment_status` / `check_run` / `workflow_run` / `pull_request_review` / `status` — the
capture paths all exist in code, but until the repo owner adds those events in GitHub's webhook settings, no
live delivery lands (`status` also needs the target repo's CI to actually post it — see the coverage/bundle/
TODO paragraph below). Until then, `reconcileRepo` is the only source for deploys, checks and runs — and it
now runs off TWO triggers, not one: an admin's manual "Sync GitHub"
(`POST /admin/backfill`, on the batch that ends the loop — see below) and, since Phase 3's Task 13, the repo
cron's 6-hourly `:20` tick (`src/repo/cron.ts`'s `handleRepoCron`) — the exact same function either way, so
a repo nobody clicks Sync on still self-heals within 6 hours. `reconcileRepo`'s arms, each wrapped in its
own `safely` block: open PRs (+ the `prs_reconciled` marker), closed PRs, the pre-capture commit window,
**deployments over GraphQL**, completed workflow runs, the failing-job label pass, the environment heads,
each environment's head checks, **branches**, and **drift**. It returns `{ written, unchanged, failed:
string[] }` — `failed` NAMES every arm that threw (`"deployments"`, `"runs"`, …), so a Sync (or a cron tick)
that silently lost one is no longer indistinguishable from one that had nothing to do; `/admin/backfill`
passes that straight through as its `repo` object, and the cron logs `failed` to the console when non-empty.

- **Deployments are ONE GraphQL request** (`ghGraphql` beside `ghJson` in `src/repo/github.ts`; POST to
  `https://api.github.com/graphql`, same bearer + user-agent, throwing on non-2xx AND on an `errors` body),
  filtered server-side by `environments: [<every cfg.railwayEnv>]` with `statuses(first:10)` inline — the
  arm is skipped entirely when no environment is configured. It replaces `GET /deployments?per_page=20`
  plus one `/statuses` call each (21 subrequests, most of them spent on Railway's PR previews). Each status
  is re-wrapped into the WEBHOOK's own `deployment_status` payload shape and put back through the pure
  `repoEventsFromDelivery` arm, so there is one derivation of a deploy row, not two. Verified live:
  `databaseId` EQUALS the REST/webhook `deployment.id` (so `gh:deploy:<id>:<state>` still collides with a
  webhook row), `state` arrives UPPERCASE and is lowercased, a Bot creator's `login` arrives WITHOUT the
  `[bot]` suffix and is re-suffixed so backfill and webhook rows agree, and a GraphQL status has no numeric
  id, so `raw.status_id` is `null`, never invented.
- **The failing-job label pass reads the BACKLOG, not this Sync's writes**: each reconcile takes the ≤5
  newest `run` rows of the last 7 days whose state is `failure`/`timed_out` and whose `title IS NULL`
  (`untitledFailedRuns` in `src/repo/reads.ts`) and calls `fillFailedJob` on each. A first Sync's leftovers
  therefore drain over later Syncs instead of staying nameless forever. Cap still 5.
- **Which environment a Workers Builds check belongs to is decided by NAME + HEAD SHA**, not by the branch
  the poll happened to ask for: the owner is the config whose `workerCheck` matches the run's name AND whose
  captured head equals the run's `head_sha` (falling back to the polled branch). When two configured
  branches share a HEAD both environments' checks come back on the first branch asked, and injecting that
  branch left the other one permanently untagged (the correctly-tagged row later dropping as `unchanged`).

Worst case one `reconcileRepo` makes **17 + 2N outbound requests** for N configured environments (21 for
today's two): 2 PR lists + 1 pre-capture commit window + 1 GraphQL deployments + 1 workflow-run list + ≤5
job lookups + ≤5 GraphQL branch pages + ≤2 drift compares + 2 per environment (head commit, head checks).
Cloudflare caps one invocation at 50 subrequests on the free plan, and reconcile shares an invocation with
`runBackfill`'s ~13 when it is the admin Sync running it. **That cap is why the repo cron gives each heavy
job its own tick** (below): health + reconcile fits, health + reconcile + the UNBOUNDED progress recompute
did not.

**The repo cron's per-tick schedule** (`src/repo/cron.ts`, `REPO_CRON = "*/10 * * * *"`, budget arithmetic
stated at the dispatcher) — ONE heavy job per invocation, keyed off the fire time's UTC minute/hour:
EVERY tick pings health (2 requests per environment, 4 today); `:00` is the hourly-polls slot (nothing else
may run on it) — today `pollCloudflare`, one GraphQL request per environment, skipped entirely unless BOTH
`CF_ANALYTICS_TOKEN` and `CF_ANALYTICS_ACCOUNT_ID` are set; Phase 5's later pollers join it there; and every 6th hour `:10` runs `recomputeAllProgress`
alone (unbounded — one request per issue number of every array-ref sprint), `:20` runs `reconcileRepo`
alone (logging `failed` when non-empty), and `:30` runs `pruneRepoCapture` (D1 only). A tick of a
non-6-hourly hour does health and nothing else.

**Reviews have no backfill arm** (`reconcileRepo` does not poll PR reviews) and no webhook subscription, so
the `R` contributor tally stays `null` until at least one of those lands.

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
twoWeeksAgo` (else its `sub` is just `"this week"`, no comparison). **The CI-failure rate follows the same
rule**: `RepoCiFailures.rate` is `number | null` and its `trend` may be `[]` — both are the seven-day
picture, so they are emitted only when `recordingSince(db, 'run') <= weekAgo`; before that a day with no
captured runs is a day capture was not running, not a green day. The failures LIST (`rows`) is NOT gated —
those rows are facts, and returning `empty` instead would render "No CI failures this week", which would
itself be false. `rate` and `trend` are computed over the SAME seven UTC calendar-day buckets
(`ciDailyRates` bounds its window at the oldest bucket's midnight). In `ciTab` (`web/src/repo.ts`) a `null`
rate draws no percentage and no sparkline, just "A 7-day rate appears after a week of captured runs.";
`repo-sample.ts` keeps its numbers. Backfilled `push` rows (one synthetic
count-1 row PER COMMIT) are excluded from the activity feed and the contributors' `pushes` tally — a
40-commit backfill would otherwise read as 40 feed lines and P=40 for one person — but still count toward
the Commits tile's totals and the 14-day bars, which read `repo_events` unfiltered by provenance.

**Everything with no capture path is `not_connected`, never guessed** — today only hosting, plus each
environment's ACTIVE USERS inside the usage section (`users: null` until Task 18's writer exists) (the
`UNCAPTURED` object is the auditable list; drift/branches/health left it with Phase 3, environments/deploys/
CI failures with Phase 2's Task 10, coverage/bundle/TODO counts with Phase 4's Task 14, usage + the
Cloudflare panel with Phase 5's Task 16 — see below). Adding a
capture path = flip one section there to `ok`; the screen already renders every section's live shape.
**Phase 3 closed drift, branches and health** (lighting up the drift strip, the branches list + Active
branches tile, and the health block feeding the HEALTHY/DEGRADED/DOWN pill — see above; no GitHub settings
change, no new secret); **Phase 4 (Task 14) closed coverage, bundle size and the TODO/FIXME count** (see the
paragraph below); **Phase 5 (Task 16) closed the Usage tab's requests / error rate and the Cloudflare panel**
(see "Cloudflare Workers analytics" below); what remains — active users and hosting — is specified in
`docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md`. `pruneRepoCapture` (`src/repo/store.ts`) is
now CALLED — the repo cron's 6-hourly `:30` tick (`src/repo/cron.ts`) — and deletes `check` rows older than
45 days ONLY `WHERE part IS NULL`: a FRONTEND deploy record IS a `check` row (the Workers Builds check,
carrying `part = 'frontend'`), and pruning it on the same schedule as a plain CI check would silently lose
the deploy dot strip's web half. The same prune also drops HOURLY usage metrics (`cf_*`, `rw_*`,
`active_users_*`) older than 100 days — the Usage tab reads 30 days at most. Because those deploy rows are never pruned, `deployHistories`
(`src/repo/reads.ts`) carries its own 90-day bound instead of grouping the whole table forever. The capture names a PR's AUTHOR and an issue's subject, not who
merged/closed — so the feed never claims an actor it does not have. "Preview with sample data" swaps in
`repo-sample.ts` client-side (session-only, labelled on screen); it never touches the Worker.

**Cloudflare Workers analytics feed the Usage tab** (Phase 5, Task 16) — a POLL, not event capture:
`pollCloudflare` (`src/repo/poll.ts`) runs on the repo cron's minute-0 tick and asks Cloudflare's GraphQL
analytics API (`https://api.cloudflare.com/client/v4/graphql`, dataset `workersInvocationsAdaptive`, filtered
by `scriptName` = each environment's `cfg.worker`, grouped by `datetimeHour`, `sum { requests errors }`) for
a 3-hour window, writing hourly `cf_requests` / `cf_errors` into `repo_metrics` (`env` = the config key,
`part = 'frontend'`). Cloudflare's schema spells its scalar **`string`, lowercase** (`$a: string!`) —
`String!` is rejected. **The window is LAGGED one hour** — `to` = the current hour's floor − 1h, `from` =
`to` − 3h (at 12:00 it reads 08:00–11:00): `putMetric` is first-write-wins, so a short count would be
PERMANENT, and the poll fires seconds after the newest hour closes, when the adaptive dataset may not have
caught up with it — every bucket gets an hour to settle before its only write. `datetime_leq` is inclusive,
so the bucket AT `to` can come back and is skipped (`at >= to`). The 3-hour overlap heals a missed tick; it
cannot re-count an hour already written. A GraphQL failure arrives as HTTP **200 with an `errors` array** —
that, a non-2xx, a thrown fetch, or a body with no account in it (nothing was looked at) costs THAT
environment the tick (logged, `data` never read beside `errors`) and the loop moves on; a malformed row
(non-finite or negative count, unparseable hour) is skipped on its own. Never throws.
**The `cf_polled` marker — no row ≠ zero unless we know we looked**: Cloudflare returns NO row for an hour
with no invocations, so a quiet hour and a dead poll look identical in `repo_metrics`. Each environment
whose poll SUCCEEDED (even with zero rows) is recorded as polled through `to` in ONE `repo_snapshots` row,
kind `cf_polled` (`CF_POLLED` in `src/repo/types.ts`), `{ [envKey]: "<to ISO>" }` — an EXCLUSIVE bound
(polled through 11:00 = the 10:00 bucket is the last one seen). One read + at most one write per poll, only
when a bound advanced; a failed environment keeps its bound, and a bound never moves BACKWARDS (compared as
parsed instants).
The projection (`projectUsage` in `src/tools/repo.ts`) costs the render **ONE statement** — `metricsSince`
(`src/repo/store.ts`: `metric IN (…)`, bound normalised like `metricSeries`) over 30 days for every range,
environment and series, sliced in memory — beside ONE `getSnapshot('cf_polled')` issued concurrently with
it (never per environment), plus ONE more (`metricsEver`, an index seek per metric name) only on the
not-`ok` path. A range is its last N COMPLETE hours (24 / 168 / 720), cut into equal buckets
(1h / 24h / 24h) that END at the last complete hour, never at UTC midnight. **Never guess, here**:
the trend is DENSE (a missing bucket is drawn as 0, else the x-axis silently compresses) but only where a
zero is entitled: the fill STARTS at the first captured point — or at the range's start when the same read
shows capture predates it (before capture began the value is unknown, not zero) — and ENDS at `min(last
complete hour, that environment's cf_polled bound)`; with NO bound it ends at the last real point, so a poll
that died days ago draws no zeros after it (a real point is always drawn, whatever the bound says). Because
of the lag, the newest hour of every range is never drawn. `requests` is non-null when there is a bucket to
draw: a `cf_requests` point IN THAT RANGE, or capture predating the range AND a polled bound inside it — the
latter a true "0" with an all-zero trend; otherwise `null` → "not connected", never "0". `errorRate` needs a
real point in range: points summing to 0 requests read a true "0.00%", but with NO point 0 of 0 is not a
rate → `null`. Totals are sums of real points only — the bound never changes a number. `usage` is `ok` when any
metric of any range is non-null, the `cloudflare` panel when the WIDEST (30d) range has rows — so a narrower
range can be `[]`, which the screen renders as "No requests in this range." — and both follow the
health/coverage three-state rule: a point EVER landed but nothing in the window → `empty`, never landed (or
no environment configured) → `not_connected`.

**Coverage, bundle size and the TODO/FIXME count are commit-status metrics** (Phase 4, Task 14) — a THIRD
capture shape beside `repo_events` and the environment/deploy `repo_snapshots`: the target repo's CI posts
each as a GitHub commit status (`context` names the metric, `description` is the number) on a push to
`main`; GitHub delivers it as a `status` webhook event, now in `REPO_EVENT_NAMES`, and `metricsFromStatus`
(`src/repo/capture.ts`) turns it into a `repo_metrics` point — a SIBLING arm to `repoEventsFromDelivery` in
`src/webhook.ts`'s repo-capture branch, not a row through it, since a status produces no `RepoEvent`. Three
contexts, one metric each: `canopy/coverage` → `coverage`, `canopy/bundle-kb` → `bundle_kb`, `canopy/todo` →
`todo_count`. A status counts only when its `branches[].name` includes the FIRST configured environment's
branch (today `main`; falling back to the literal `"main"` when no environment is configured) — a feature
branch's coverage is not the repo's — and an unrelated context (Railway's or CodeRabbit's own statuses,
frequent once the webhook subscribes to Statuses) is dropped after one cheap parse, costing zero D1 writes.
**`description` must be a strict decimal, range-checked per metric** — `repo_metrics` is append-only and
these three metrics are never pruned, so a bad point is PERMANENT. `Number(str(description))` alone accepted
far too much (`Number(null) === 0`, a finite number — a `canopy/*` status with NO description silently
stored a metric of `0` forever; `Number` also accepts `"1e3"`, `"0x10"`, a leading `-`).
`metricsFromStatus` now requires the trimmed description to match `/^\d+(\.\d+)?$/` (no sign, exponent, hex,
percent sign, or empty string) AND fall inside the metric's plausible range — coverage 0–100, bundle_kb
0–10,000,000, todo_count 0–10,000,000 as an INTEGER — kept beside the context→metric map (`STATUS_METRICS`)
so the two read as one table; anything else is dropped, never stored. `metricsFromStatus` stays PURE (no
`console`) — it returns a `StatusMetricOutcome` (`{ metrics, dropped }`) where `dropped` is set only when the
context WAS one of the three `canopy/*` names and the point was dropped (by the branch filter or by
validation); `src/webhook.ts`'s `status` arm is the one that `console.warn`s it once, naming the context and
reason (never the raw description beyond ~40 chars) — an unrelated context stays silent and free.
`putMetric` (`src/repo/store.ts`) returns whether it wrote a NEW row (false for a redelivery or an
unparseable `at`), so the webhook counts only newly-captured metrics into `repo.captured`, a redelivery into
`repo.unchanged` — the same shape every other repo-capture kind reports. **`metricSeries`'s `sinceIso` bound
is normalised the same way `at` is stored** (`Date.parse` → `toISOString()`) before the comparison: `at`
is compared as a raw string, and a caller-computed bound lacking milliseconds (`…00Z`) would otherwise sort
AFTER a normalised `…00.000Z` row of the exact same instant and wrongly exclude it; an unparseable bound now
returns `[]` instead of every row ever written. **A delta claims a trend only once the window holds ≥2
points whose first and last are ≥7 days apart** (`windowDelta` in `src/tools/repo.ts`) — a single reading,
or two readings a day apart, cannot support "over 30 days" (coverage/bundle read a 30-day window) or a
"since" date (the TODO count reads a 90-day window — it moves slowly enough that 30 days too often holds
only one point); its baseline is the window's FIRST point, which — once a series holds more than 10 readings
— may lie left of the 10-point sparkline drawn beside it. Below that bar, `RepoTrend.delta` is `""` (the
screen renders no delta text and no stray leading space where it used to sit) and `RepoTodos.delta` is
`null` (`number | null` in `shared/repo.ts` — no delta chip and no "since" text); the value/count still show
regardless, but the sparkline itself is now also suppressed below 2 points (`sparkPoints` already returned
`""` for fewer than 2 — `web/src/repo.ts`'s `spark()` now renders no element at all rather than an empty
box). **All three sections — not two — read `empty`, not `not_connected`, once a metric has landed before
but nothing falls inside its window**: `getRepoDashboard` checks `latestMetric(db, metric, "", "")` only on
the empty path (non-null → `empty`, null → `not_connected`), so a metric that stopped reporting reads
truthfully as "gone quiet" rather than "never connected" — same distinction the `health` block already drew.
All three stay `not_connected` from a cold start, until BOTH the webhook subscribes to `status` (see above)
AND the target repo's CI actually posts these statuses — the CI-side YAML (the workflow `permissions` block,
the `pytest-cov` lockfile caveat, why bundle size is left optional) is written up in
`docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`, a PR against the separate `SaplingLearn/sapling`
repository that this repo cannot carry directly.

`POST /admin/backfill` runs `reconcileRepo` **once per Sync, on the batch that ENDS the loop** — either the
batch whose `BackfillResult.summaryBudgetExhausted` reads `false` (the normal last call), OR the batch that
hits the frontend's own cap while the budget is STILL exhausted (the server has no other way to see the
client's loop counter, so a Sync that maxes out `MAX_BACKFILL_BATCHES` without ever clearing the budget
would otherwise never reconcile). `isFinalBackfillBatch(result, batch?, of?)` (`src/tools/backfill.ts`) is
`true` when the budget is not exhausted, OR when the caller-supplied `batch >= of`; `web/src/main.ts`'s
`runAdminBackfillLoop` sends its 1-based batch number and `MAX_BACKFILL_BATCHES` (10) as `{ batch, of }` in
the POST body, and the route reads them defensively (absent/malformed → behaves as before, gating on the
budget alone). The SPA can re-POST this route up to 10 times per Sync while the summarizer budget stays
exhausted, and `reconcileRepo` redoes ~250 no-op statements on an already-reconciled repo, so running it on
every intermediate batch would waste that work repeatedly for nothing; the route folds its
`{ written, unchanged }` into the JSON response as `repo`, present only when it actually ran. Still
best-effort (`.catch(() => undefined)`) and unable to fail the route.

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
(app-level token for the sprint-progress backstop AND the repo cron's GitHub reconcile — absent → the
cron's `:10` and `:20` 6-hourly ticks are skipped; the `:30` prune is D1-only and runs regardless, as do
the health pings on every tick),
`GEMINI_API_KEY`
(Google Gemini key for capture-time PR/issue summaries — absent → the excerpt fallback), `RESEND_API_KEY`
(email delivery; needed only when `NOTIFICATIONS_MODE = "resend"`), `CF_ANALYTICS_TOKEN` (a Cloudflare API
token with Account Analytics: Read) and `CF_ANALYTICS_ACCOUNT_ID` (the account the frontend Workers live
under — a SECRET too, never a `[vars]` entry: a var and a secret sharing a binding name collide and fail the
deploy); absent either → the hourly Cloudflare analytics poll is skipped and the Usage tab's requests /
error rate and Cloudflare panel stay `not_connected`. They are deliberately NOT named `CLOUDFLARE_API_TOKEN`
/ `CLOUDFLARE_ACCOUNT_ID`, because those are the names the wrangler CLI itself authenticates with. Vars
(`[vars]` in `wrangler.toml`): `GITHUB_REPO` (e.g. `SaplingLearn/sapling`), `ADMIN_LOGINS`, `PUBLIC_ORIGIN`
(absolute origin for links inside email), `NOTIFICATIONS_MODE` (`local` default / `resend`),
`REPO_ENVIRONMENTS` (a JSON list, parsed by `src/repo/config.ts`'s `repoEnvironments()` — which branch
deploys to which environment plus its Worker/URLs; absent or malformed → `[]`. Today it encodes two:
**staging** deploys from `main`, **production** from a `production` branch; backend on Railway, frontend on
Cloudflare Workers. Now read in FIVE places: the webhook's repo capture
(matching a `deployment_status`/`check_run` delivery to its environment), the dashboard projection
(`getRepoDashboard`'s `envs` param — the `environments`/`deploys`/`health` sections stay `not_connected` when
it is empty; `ciFailures` does NOT consult it and is gated only on `run` capture), `reconcileRepo` — which
reads it for the GitHub ENVIRONMENT NAMES the deployments GraphQL query filters on, and separately for the
BRANCHES whose head commit, head checks, and drift/branch comparisons it polls — and the repo cron's
`pingHealth` (`src/repo/poll.ts`), which reads it for the two ping targets (frontend URL, `apiUrl +
healthPath`) per environment — and `pollCloudflare`, which reads each environment's `worker` (the
script name the analytics query filters on) and `key`. Absent → no deployments arm, no env-head or head-checks arms, no drift
compare (it needs two environments), no health pings and no analytics poll, and
`environments`/`deploys`/`health`/`usage`/`cloudflare` stay
`not_connected` — but the **branches arm still runs**: `computeBranches` degrades correctly with `envs: []`
(head `main`, nothing excluded from the list), so a repo with no `REPO_ENVIRONMENTS` still gets a branches
snapshot rather than losing one for no structural reason).
Bindings: `DB`
(D1), `ASSETS` (static). Capture-time summaries call Gemini over REST (`GEMINI_API_KEY`), never at render —
not a Cloudflare binding, so there is no `[ai]` block. `[triggers] crons` is three expressions: `*/10 * * * *`
drives the repo cron (`src/repo/cron.ts`'s `handleRepoCron`), which spreads ONE heavy job per invocation
across its six ticks an hour — environment health pings on EVERY tick; `:00` the hourly-polls slot (today
the Cloudflare analytics poll); and, every 6th hour, `:10` the sprint-progress backstop, `:20` the GitHub reconcile and `:30`
the capture prune, each alone in its invocation because Cloudflare caps one at 50 subrequests — plus the two
hourly digest candidates (see Email notifications). `src/index.ts` dispatches by EXACT string equality on
`controller.cron`, so `REPO_CRON` and the expression in `wrangler.toml` must stay identical (pinned by a
test).
