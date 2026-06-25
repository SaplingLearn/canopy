# Canopy

Shared context store backend. One Cloudflare Worker on one origin serves the API,
the MCP endpoint, and the static web build (via the assets binding).

- `shared/` — Zod contract, vocabulary, D1 row types (imported by `src/` and `web/`)
- `src/` — Worker: routes, consumer, db, tools, mcp
- `web/` — placeholder static build (smoke test only)
- `migrations/` — D1 SQL

## Develop
- `npm test` — Vitest against a real Miniflare D1
- `npm run typecheck` — type-check worker + web
- `npm run dev` — build web, then `wrangler dev`

## Auth & secrets

Auth gates all data routes (session cookie) and `/mcp` (per-person bearer token), allowing
only active members of the `SaplingLearn` GitHub org. Set these Wrangler secrets (never commit them):

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — a GitHub OAuth App whose callback is
  `https://<host>/auth/callback`.
- `COOKIE_SECRET` — a long random string used to sign the session cookie.

Production: `wrangler secret put GITHUB_CLIENT_ID` (and the others).
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it in.
The `database_id` in `wrangler.toml` is still a local placeholder — replace it with a real id
(`npm run db:create`) before any remote deploy.

Mint an MCP token from a logged-in session: `POST /auth/mcp-token` → `{ "token": "canopy_mcp_..." }`
(shown once). Connect Claude Code with `--header "Authorization: Bearer canopy_mcp_..."`.
