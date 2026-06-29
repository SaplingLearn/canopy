# Canopy

Shared context store. One Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, and a full single-page app (TypeScript + Vite,
served via the ASSETS binding). Live at `canopy.saplinglearn.com`.

- `shared/` — Zod contract, vocabulary, D1 row types (imported by `src/` and `web/`)
- `src/` — Worker: `index.ts` (router), `routes.ts` (Hono HTTP), `mcp.ts` (MCP tools),
  `consumer.ts` (the gate — replay-safe, hash-deduped, change-typed), `db.ts`, `tools/`
- `web/` — Full SPA with screens: My Work (default dashboard), Feed, Docs, Roadmap,
  Triage, Search, Settings, and a Get Started guide. Built to `web/dist`.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`)
- `.claude/skills/` — `load-context` (read/orient) and `record-session` (session-end batch writer)

## Read side

FTS5 full-text search: `query()` ranks by bm25 + authority flag, assembles full bodies for
top hits, and returns ranked pointers for the rest. Backs `GET /search` and MCP `query`.
`get_doc` fetches a single doc with all its versions; `get_feed` streams the activity feed;
`get_roadmap` merges live GitHub progress at read time (degrades gracefully if token absent).

## Write side (agents stage, humans confirm)

Every agent write flows through the gate in `src/consumer.ts` — replay ledger
(`processed_items`), content-hash dedupe, change-typing (new/edit/rewrite), and
out-of-vocab or low-confidence entries route to `needs_triage`. HTTP confirm routes
(promote, ratify, reject, assign, discard) are session-cookie-only — never MCP tools.

MCP write tools: `append_feed`, `propose_doc_update`, `propose_milestone`, `set_focus`.

## Develop

- `npm test` — Vitest against a real Miniflare D1
- `npm run typecheck` — type-check worker + web
- `npm run dev` — build web, then `wrangler dev`
- `npm run deploy` — build web, then `wrangler deploy`
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations

## Auth & secrets

Auth gates all data routes (session cookie) and `/mcp` (per-person bearer token), allowing
only active members of the `SaplingLearn` GitHub org. Set these Wrangler secrets:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — a GitHub OAuth App whose callback is
  `https://<host>/auth/callback`.
- `COOKIE_SECRET` — a long random string used to sign the session cookie.

Production: `wrangler secret put GITHUB_CLIENT_ID` (and the others).
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it in.

Mint an MCP token from a logged-in session: `POST /auth/mcp-token` → `{ "token": "canopy_mcp_..." }`
(shown once). Connect Claude Code to the live endpoint:
`claude mcp add --transport http canopy https://canopy.saplinglearn.com/mcp --header "Authorization: Bearer canopy_mcp_..."`.
