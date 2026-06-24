# Sapling Context Store

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
