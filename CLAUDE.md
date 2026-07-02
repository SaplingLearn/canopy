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
  tool map (the plan model; no `focus`, no `propose_milestone`). Its `references/querying.md` is the full
  `query` parameter reference (filtering, browse, pointers, `include_staged`). Start here.
- **`load-context`** (auto-fires, read-only) — **orient before touching an existing area**: it calls
  `query` (assembled authoritative bodies + ranked pointers, each authority-flagged) so you build on what
  exists instead of guessing, and at session start also calls `get_my_work`. ALWAYS run it before
  proposing a doc change (note the doc's `current_version` as the writer's base).
- **`record-session`** (explicit only — never auto-fires) — at **session end**, observe what actually
  shipped (`git`/`gh`), read the touched docs back from Canopy, and stage **one** reconciled batch via
  the `record_session` MCP tool (feed / doc / ADR / triage / event items — a bearer-reachable batch over
  the same gate as `/ingest`).

Three more skills cover the roadmap/my-work surfaces:

- **`read-plan`** (admin, read-only) — read the current plan and check it against captured reality.
- **`update-plan`** (admin, explicit) — push a reshaped plan back through the direct, non-destructively
  versioned plan-write path (`update_plan`), including setting a milestone `done`.
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
  `dashboard.ts` (the My Work DTO shared by the Worker and web).
- `src/` — the Worker. `index.ts` (fetch entry: `/mcp` by bearer, `/webhook/github` by HMAC, everything
  else to the Hono app; plus the `scheduled()` progress backstop), `routes.ts` (Hono HTTP), `mcp.ts` (MCP
  tools), `consumer.ts` (THE GATE), `webhook.ts` (GitHub event capture), `tools/` (`writes.ts`, `reads.ts`,
  `plan.ts`, `mywork.ts`, `progress.ts`, `summarize.ts`), `db.ts` (D1 helpers), `auth/`, `env.ts`.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`, then `0011_fts_recreate`,
  `0012_events_plan` [events / pr_summaries / milestone_progress / people / plan / plan_versions +
  `milestones.phase`], `0013_roadmap_fts`, `0014_drop_focus` [retires `0007_focus`],
  `0015_drop_user_token` [drops `users.github_token`]).
- `web/` — full TypeScript/Vite single-page app (My Work, Feed, Docs, Roadmap, Triage, Search,
  Settings, Get Started) served via the ASSETS binding; `web/src/markdown.ts` renders PR summaries and the
  roadmap narrative as styled HTML.
- `.claude/skills/` — Claude Code skills: `canopy`, `load-context`, `record-session`, and the roadmap/
  my-work skills `read-plan`, `update-plan`, `my-work`. Described in the Working memory section above.

## Core invariant — ingested content is gated; authored & computed writes are direct

`consume()` is an **ingestion** gate, not a universal write gate: it polices agent-proposed content
(vocab, confidence, content-hash dedupe, reconciliation). Every ingested entry funnels through the
per-type **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` /
`ingestAdrDraft` / `ingestMilestoneProposal` / `ingestEvent`). The ingestion entry points are thin
adapters over these: `/ingest` and the MCP `record_session` batch tool (both via `consume`), the
per-entry MCP write tools (`append_feed`, `propose_doc_update`), and the `/webhook/github` branch
(`ingestEvent`). The gate **reconciles**, not just routes:

- **Replay ledger** (`processed_items`, keyed by `session.id + item_index`): a re-POST of the same
  payload drops every item as `unchanged` — nothing is double-written. MCP tools use an ephemeral
  UUID session so each call is independently reconciled without ever hitting the ledger.
- **Content-hash dedupe** (SHA-256 via Web Crypto): an identical body for an existing slug/ADR/milestone
  is a no-op (`unchanged`) unless `force: true` is passed.
- **Change-typing**: `change_kind` (`new` / `edit` / `rewrite`) is server-computed via a line LCS diff
  of the proposed body against the current promoted body; `base_version` records the version the writer
  read, surfacing stale-edit warnings. Both are stored on `doc_versions`.
- **Low-confidence nuance**: low-conf on a NEW slug → triage; low-conf on an EXISTING slug → stage and
  flag (`low_confidence = 1`) for human scrutiny. Only low-conf new slugs go directly to triage.
- Out-of-vocab tag/section or a milestone `status:'done'` → routed to `needs_triage` (nothing is guessed).
- **Events** carry no vocab/confidence — an event is external fact captured verbatim, deduped by a UNIQUE
  `semantic_key` (`gh:pr:42:merged`, `gh:issue:…`) written `INSERT OR IGNORE` (a redelivery/backfill
  overlap drops as `unchanged`). Its `subject_login` is a SECOND identity (who the event is about),
  trusted only post-HMAC — distinct from the writer.
- **Author is ALWAYS the authenticated principal**, passed in by the caller. The client-supplied
  `session.author` is advisory and ignored. (This writer rule does NOT clobber an event's `subject_login`.)

Authored and computed writes are **direct, in the `promote` class** — NOT the ingestion gate — exactly
like `promote_doc` / `promote_milestone_proposal` / `complete_milestone` always have been: the plan write
(`update_plan` → `write_plan`, versioned non-destructively) and the computed writes (the progress cache in
`tools/progress.ts`, the PR summaries in `tools/summarize.ts`). When adding an **ingestion** path
(agent-proposed content), add it to the gate — never a second ingestion surface; authored/computed writes
stay direct in the promote class.

## Read side — FTS5 query engine

`src/tools/reads.ts` exposes a ranked FTS5 `query()` engine (bm25, title/summary weighted) that backs
both MCP `query` and `GET /search`, over four types: `doc` / `decision` / `feed` / `milestone`. Each
result is authority-flagged: `live` / `staged_pending` / `unpromoted` / `draft`. The doc/feed/ADR index
lives in `migrations/0008_fts.sql` (recreated in `0011_fts_recreate.sql`); `0013_roadmap_fts.sql` adds a
standalone `roadmap_fts` over the plan narrative + milestones so `query` surfaces the roadmap. `get_doc`
is the exact-slug fetch (all versions + live body).

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
- Milestones: `milestone_proposals` rows are staged ONLY via triage-assign now (the `propose_milestone`
  MCP tool was retired; the gate fn `ingestMilestoneProposal` remains for that path). `POST
  /milestone-proposals/:id/promote` materializes a live `milestones` row; `POST /milestones/:id/complete`
  flips status to `done`. `'done'` is NEVER set by the worker and NEVER inferred from issue closure — a
  milestone is completed by an admin, in Triage-promote or in the plan write.
- Triage write-back: `POST /needs-triage/:id/discard` (soft dismiss) and `POST /needs-triage/:id/assign`
  (re-runs the item's `raw` through the SAME gate for the target type, then records `resolution='assigned'`
  with `assigned_ref`). All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.

## Auth — three classes, no new flow (fully built — don't add one)

GitHub OAuth + PKCE, gated to **active members of the `SaplingLearn` org** (`SAPLING_ORG` in
`src/auth/github.ts` — a real external org, do not rename it). Three auth classes, kept separate:

- **Session cookie** (humans, the Hono app): signed cookie; every route except `/auth/login|callback`
  passes `sessionGate`. The principal (`{ login }`) is resolved from the session.
- **Bearer token** (agents, `/mcp`): per-person tokens stored hashed (`canopy_mcp_` prefix); the principal
  is resolved from the bearer. `/mcp` is **bearer-only** — on bad/missing creds it returns a bare `401`
  with NO `WWW-Authenticate` and NO OAuth discovery. A fresh `McpServer` is constructed per request
  (SDK ≥1.26 guards against reuse); `createMcpHandler` is stateless (no Durable Object / McpAgent).
- **GitHub webhook** (`/webhook/github`, `src/webhook.ts`): a delivery authenticates by an HMAC-SHA256
  `X-Hub-Signature-256` over the raw body against `GITHUB_WEBHOOK_SECRET` (NOT `COOKIE_SECRET`). HMAC is
  verified in the branch BEFORE the gate; a bad/absent signature (or unset secret) is a bare `401`. The
  writer principal is the fixed string `"github-webhook"`; the delivery's own `subject_login` is trusted
  only post-verify. This branch never touches `sessionGate`.

## Roadmap & My Work — authored plan + stored projections, no live GitHub at render

The roadmap is two layers. **The plan** (narrative + milestones + timeline) is admin-authored via the
`update_plan` MCP tool (`update-plan` skill) → `write_plan`: a direct promote-class write, versioned
non-destructively into `plan` (singleton narrative) + `plan_versions` snapshots, over the `milestones`
table (which now carries `description` and `phase`). Milestone `done` is admin-set here, never
event-inferred. `GET /roadmap` and MCP `get_roadmap` read `get_plan`: narrative + milestones in
target-date order merged with the cached progress. No live GitHub, no per-user token.

**Progress** is a stored cache (`milestone_progress`), written as ABSOLUTE `closed`/`total` (so delivery
order is irrelevant — the last write wins) by two direct writers: the webhook (event-derived, on issue
events) and the `scheduled()` cron backstop (`recomputeAllProgress`, `GITHUB_SERVICE_TOKEN`, off the
render path). `github_ref` is bare (a milestone number OR a JSON array of issue numbers) resolved against
`GITHUB_REPO` — only by those two writers, never at render.

**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events: two separate lists — `previousActivity` (summarized merged/closed PRs where the person is the
subject, last 14 days) and `todo` (their open assigned issues) — built from `events` (+ `pr_summaries`,
`people`), no live GitHub. `person` resolves via the `people` identity map; an unmapped login yields an
empty projection (`degraded:false`); any D1 failure yields empty `degraded:true` — never a 500. Completed
PRs are summarized ONCE, at capture time (`tools/summarize.ts`: Workers AI `env.AI`, deterministic excerpt
fallback), stored in `pr_summaries` and regenerable — never truth, never generated at render. Issues are
never summarized.

## Conventions & gotchas

- `shared/vocabulary.ts` MUST match `migrations/0002_seed_vocab.sql` — it's the gate's source of truth.
- D1 helpers live in `src/db.ts` (`first` / `all` / `run` / `nowIso`); writers in `src/tools/writes.ts`.
- Tests use real Miniflare D1; `test/apply-migrations.ts` truncates data tables `beforeEach` (add new
  tables — `events`, `pr_summaries`, `milestone_progress`, `people`, `plan`, `plan_versions` — there).
  GitHub I/O and the PR summarizer are dependency-injected (`fetchImpl?: typeof fetch`, `summarizer`)
  because the vitest pool exports no fetch/AI mock — stub at the `Response`/`Summarizer` level, never hit
  the network in tests.
- **Deferred seams — do NOT activate:** Cloudflare Queue, Vectorize, the GitHub OAuth provider for MCP.
  They exist as `// SEAM:` comments only.

## Env / bindings

Secrets (`wrangler secret put …`; local: `.dev.vars`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`COOKIE_SECRET`, `GITHUB_WEBHOOK_SECRET` (HMAC for the webhook — absent → the surface 401s),
`GITHUB_SERVICE_TOKEN` (app-level token for the scheduled progress recompute — absent → `scheduled()`
no-ops). Vars (`[vars]` in `wrangler.toml`): `GITHUB_REPO` (e.g. `SaplingLearn/canopy`). Bindings: `DB`
(D1), `ASSETS` (static), `AI` (Workers AI — capture-time PR summaries only, never at render).
`[triggers] crons` drives the progress recompute backstop.
