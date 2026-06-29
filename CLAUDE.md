# CLAUDE.md

Canopy — a shared context store backend. **One** Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, and the static web build (via the assets binding). Agents (Claude
Code sessions) write context through a single gated path; humans confirm the consequential changes.

## Working memory (use the skills)

Canopy is the team's working memory, and three skills under `.claude/skills/` are **the root of how it
stays living** (orient → work → record), not a side feature:

- **`canopy`** — the umbrella/overview skill: the whole loop, the authority model, and the read/write
  tool map. Its `references/querying.md` is the full `query` parameter reference (filtering, browse,
  pointers, `include_staged`). Start here to understand the system.
- **`load-context`** (auto-fires, read-only) — **orient before touching an existing area**: it calls
  `query` (assembled authoritative bodies + ranked pointers, each authority-flagged) so you build on what
  exists instead of guessing. ALWAYS run it before proposing a doc change (note the doc's
  `current_version` as the writer's base).
- **`record-session`** (explicit only — never auto-fires) — at **session end**, observe what actually
  shipped (`git`/`gh`), read the touched docs back from Canopy, and stage **one** reconciled batch via
  the `record_session` MCP tool (a bearer-reachable batch over the same gate as `/ingest`).

Trust `live` results; **scrutinize `staged_pending` / `unpromoted` / `draft`** — anything not `live` is
not-yet-settled and must not be treated as established fact. Agents only ever stage; a human confirms in
Triage. That staging-plus-confirmation loop is what keeps the store trustworthy as it grows.

## Commands

- `npm test` — Vitest against a real Miniflare D1 (the source of truth for "is it green").
- `npm run typecheck` — `tsc` over worker + web (does NOT run in `npm test`; run it too).
- `npm run dev` — build web, then `wrangler dev`. `npm run deploy` — build web, then `wrangler deploy`.
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations.
- Run one test file: `npx vitest run test/<file>.test.ts`.

## Layout

- `shared/` — the ONLY shared layer (imported via the `@shared` alias by `src/` and `web/`):
  `contract.ts` (Zod ingest contract), `vocabulary.ts` (controlled vocab), `rows.ts` (one type per D1 table).
- `src/` — the Worker. `index.ts` (fetch entry: routes `/mcp` by bearer, everything else to the Hono app),
  `routes.ts` (Hono HTTP), `mcp.ts` (MCP tools), `consumer.ts` (THE GATE), `tools/` (`writes.ts`,
  `reads.ts`, `roadmap.ts`), `db.ts` (D1 helpers), `auth/`, `env.ts`.
- `migrations/` — D1 SQL (`0001_init`, `0002_seed_vocab`, `0003_auth`, `0004_roadmap`,
  `0005_doc_space`, `0006_avatar`, `0007_focus`, `0008_fts`, `0009_reconcile`, `0010_triage_resolve`).
- `web/` — full TypeScript/Vite single-page app (My Work, Feed, Docs, Roadmap, Triage, Search,
  Settings, Get Started) served via the ASSETS binding.
- `.claude/skills/` — Claude Code skills: `load-context` (read-only orient, model-invocable) and
  `record-session` (explicit session-end batch writer via the `record_session` MCP tool). Referenced in
  the Working memory section above.

## Core invariant — the single gated write path

Every write funnels through the per-entry **gate** functions in `src/consumer.ts`
(`ingestFeedEntry` / `ingestDocProposal` / `ingestAdrDraft` / `ingestMilestoneProposal`). Both entry
points are thin adapters over these: `/ingest` and the MCP `record_session` batch tool (both via
`consume`), plus the per-entry MCP write tools (`append_feed`, `propose_doc_update`, `propose_milestone`,
`set_focus`). The gate now **reconciles**, not just routes:

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
- **Author is ALWAYS the authenticated principal**, passed in by the caller. The client-supplied
  `session.author` is advisory and ignored.

When adding a write, add it to the gate — never introduce a second write surface.

## Read side — FTS5 query engine

`src/tools/reads.ts` exposes a ranked FTS5 `query()` engine (bm25, title/summary weighted) that backs
both MCP `query` and `GET /search`. Each result is authority-flagged: `live` / `staged_pending` /
`unpromoted` / `draft`. The FTS index lives in `migrations/0008_fts.sql` (standalone virtual tables +
triggers; re-indexed on promote). `get_doc` is the exact-slug fetch (all versions + live body).

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
- Milestones: `propose_milestone` stages a `milestone_proposals` row; `POST /milestone-proposals/:id/promote`
  materializes a live `milestones` row; `POST /milestones/:id/complete` flips status to `done`.
  `'done'` is NEVER set by the worker and NEVER inferred from 100% issue closure.
- Triage write-back: `POST /needs-triage/:id/discard` (soft dismiss) and `POST /needs-triage/:id/assign`
  (re-runs the item's `raw` through the SAME gate for the target type, then records `resolution='assigned'`
  with `assigned_ref`). All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.

## Auth (fully built — don't add a new flow)

GitHub OAuth + PKCE, gated to **active members of the `SaplingLearn` org** (`SAPLING_ORG` in
`src/auth/github.ts` — a real external org, do not rename it). Sessions = signed cookie; MCP = per-person
bearer tokens stored hashed (`canopy_mcp_` prefix). The principal (`{ login }`) is resolved from the
session (HTTP) or bearer (`/mcp`) and threaded into the gate. The org OAuth token is retained
**AES-GCM-sealed under `COOKIE_SECRET`** (no new secret) for live roadmap reads.

`/mcp` is **bearer-only**: on bad/missing creds it returns a bare `401` with NO `WWW-Authenticate` and
NO OAuth discovery. A fresh `McpServer` is constructed per request (SDK ≥1.26 guards against reuse);
`createMcpHandler` is stateless (no Durable Object / McpAgent).

## Roadmap progress is computed live, stored nowhere

`GET /roadmap` and MCP `get_roadmap` read `milestones` and merge progress computed from GitHub at read
time (`src/tools/roadmap.ts`), using the principal's stored token + the `GITHUB_REPO` var. `github_ref`
is bare (a milestone number OR a JSON array of issue numbers) resolved against `GITHUB_REPO`. If the
token is absent/expired/revoked, milestones are returned WITHOUT progress — never a 500.

## Conventions & gotchas

- `shared/vocabulary.ts` MUST match `migrations/0002_seed_vocab.sql` — it's the gate's source of truth.
- D1 helpers live in `src/db.ts` (`first` / `all` / `run` / `nowIso`); writers in `src/tools/writes.ts`.
- Tests use real Miniflare D1; `test/apply-migrations.ts` truncates data tables `beforeEach` (add new
  tables there). GitHub I/O is dependency-injected (`fetchImpl?: typeof fetch`) because the vitest pool
  exports no fetch mock — stub at the `Response` level, never hit the network in tests.
- **Deferred seams — do NOT activate:** Cloudflare Queue, Vectorize, the GitHub OAuth provider for MCP,
  the issue webhook. They exist as `// SEAM:` comments only.

## Env / bindings

Secrets (`wrangler secret put …`; local: `.dev.vars`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`COOKIE_SECRET`. Vars (`[vars]` in `wrangler.toml`): `GITHUB_REPO` (e.g. `SaplingLearn/canopy`).
Bindings: `DB` (D1), `ASSETS` (static).
