# CLAUDE.md

Canopy — a shared context store backend. **One** Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, and the static web build (via the assets binding). Agents (Claude
Code sessions) write context through a single gated path; humans confirm the consequential changes.

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
- `migrations/` — D1 SQL (`0001_init`, `0002_seed_vocab`, `0003_auth`, `0004_roadmap`).
- `web/` — placeholder static build (smoke test only).

## Core invariant — the single gated write path

Every write funnels through the per-entry **gate** functions in `src/consumer.ts`
(`ingestFeedEntry` / `ingestDocProposal` / `ingestAdrDraft` / `ingestMilestoneProposal`). Both entry
points are thin adapters over these: `/ingest` (via `consume`) and the MCP write tools (`append_feed`,
`propose_doc_update`, `propose_milestone`). The gate decides write-vs-stage-vs-triage:

- Out-of-vocab tag/section, low confidence, or a milestone `status:'done'` → routed to `needs_triage`
  (nothing is guessed).
- **Author is ALWAYS the authenticated principal**, passed in by the caller. The client-supplied
  `session.author` is advisory and ignored.

When adding a write, add it to the gate — never introduce a second write surface.

## Staged-write model — agents stage, humans confirm

Agents only ever stage; humans confirm via **authenticated HTTP routes that are NEVER MCP tools**:

- Docs: `propose_doc_update` stages a `doc_versions` row (status `staged`); `POST /doc/:slug/promote`
  copies it into the live doc and bumps `current_version` (non-destructive; prior versions remain).
- ADRs: `stage_adr` stages a `draft`; `POST /adr/:id/ratify` flips it to `ratified`.
- Milestones: `propose_milestone` stages a `milestone_proposals` row; `POST /milestone-proposals/:id/promote`
  materializes a live `milestones` row; `POST /milestones/:id/complete` flips status to `done`.
  `'done'` is NEVER set by the worker and NEVER inferred from 100% issue closure.

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
