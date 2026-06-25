# Canopy — Backend (v1) Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — ready for implementation plan
**Scope:** Data + Worker layer only. No real UI. Repo set up so the frontend lives in the same project and shares code with the Worker.

## 1. Purpose

The Canopy context store is the shared source of truth that Claude Code sessions
read from and write to at the end of a session. The only interface between a coding
session and the cloud is one JSON payload (the contract). The session does all
curation and sends clean, structured data. The Worker **validates and writes; it
never re-interprets meaning, only verifies structure.**

This first pass builds the data and Worker layer. Everything is served from **one
Worker on one origin** via Workers Static Assets: `docs.saplinglearn.com/` serves the
site and `docs.saplinglearn.com/ingest` (and `/feed`, `/mcp`, …) hits the Worker —
same origin, same deploy, no CORS.

## 2. Stack

Cloudflare Workers, Hono, D1, TypeScript, Wrangler. Zod for validation, Vitest for
tests. MCP via `createMcpHandler` from `agents/mcp` (`agents@^0.16`). Vite for the
`web/` build. One npm package, path alias for the shared layer.

## 3. Architecture (fixed — not to be redesigned)

- One JSON payload is the only session→cloud interface. Worker validates structure,
  never re-interprets meaning.
- Three content types, three autonomy levels:
  - **Feed** — append-only working memory, written directly.
  - **Docs / diagrams** — versioned proposals, staged (never promoted automatically).
  - **Decisions (ADRs)** — drafted and staged for human ratification.
- **Sections and tags are a controlled vocabulary.** Anything outside it, or marked
  low confidence, routes to `needs_triage` instead of being guessed.
- **Doc writes are never destructive:** insert a new version row; leave
  `current_version` until a human promotes.
- **Boundary discipline:** the frontend talks to the Worker only over HTTP routes. It
  never imports `consumer` or `db` modules directly even though they compile in the
  same repo. The API is the boundary. The only thing `web/` and `src/` share is
  `shared/`.

The `shared/` layer is the point of one repo, not the deploy convenience. The
contract, the vocabulary, and the row types are written once in `shared/` and imported
by both sides, so a schema change can never drift between the API and the UI.

## 4. Repo & module layout

```
canopy/
  package.json          one package, npm
  tsconfig.json         base + @shared/* path alias
  wrangler.toml         d1 binding (DB), assets binding (-> web/dist), routes
  vitest.config.ts      @cloudflare/vitest-pool-workers (real Miniflare D1)
  migrations/
    0001_init.sql        all tables
    0002_seed_vocab.sql  sections + starter tags
  shared/               imported by BOTH src and web — the anti-drift layer
    contract.ts          Zod envelope + inferred types
    vocabulary.ts        SECTIONS + TAGS arrays, trivially editable
    rows.ts              D1 row types (one per table)
  src/
    index.ts             Worker entry: /mcp -> mcp handler; else Hono; assets via binding
    db.ts                low-level D1 helpers (typed, return rows.ts types)
    tools/               the named functions over db (the reusable units)
                         reads:  get_doc, list_docs, get_feed, search_context
                         writes: append_feed, propose_doc_update (+ stage_adr, route_triage)
    consumer.ts          ingest orchestration: vocab gate + fan-out to tools
    routes.ts            Hono routes — thin adapters over tools/consumer
    mcp.ts               createMcpHandler wiring — thin adapters over the SAME tools
  web/
    index.html
    src/main.ts          placeholder: fetch /feed, dump raw JSON to the page
    vite.config.ts       builds to web/dist
```

**Module separation (required):** `shared` (contract, vocab, types); and in `src`:
`routes`, `consumer`, `db`, `tools`, `mcp`. Strong types throughout.

**Boundary discipline:** `web/` imports only from `shared/`. It never imports `src/`.
`src/tools/*` are plain functions over `db`. Both `routes.ts` and `mcp.ts` are thin
adapters over those same functions — no duplicated logic.

## 5. The contract (shared/contract.ts)

The payload the session sends, as a Zod schema. The **only** deviation from the
literal spec payload: `doc_proposals[].title` is an **optional** field (the session
sends a real title when it has one). The title fallback lives in the consumer, not the
schema, so a proposal without a title still inserts cleanly.

```ts
import { z } from "zod";

export const Session = z.object({
  author: z.string(),
  ended_at: z.string(),            // ISO8601
  skill_version: z.string(),
});

export const FeedEntry = z.object({
  summary: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  artifacts: z.object({
    prs: z.array(z.string()).default([]),
    commits: z.array(z.string()).default([]),
  }),
});

export const DocProposal = z.object({
  slug: z.string(),
  section: z.string(),
  title: z.string().optional(),          // NEW vs literal payload
  body: z.string(),                      // markdown, or mermaid/d2 for diagrams
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const AdrDraft = z.object({
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  rationale: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const TriageItem = z.object({
  raw: z.string(),
  reason: z.string(),
});

export const IngestPayload = z.object({
  session: Session,
  feed_entries: z.array(FeedEntry).default([]),
  doc_proposals: z.array(DocProposal).default([]),
  adr_drafts: z.array(AdrDraft).default([]),
  needs_triage: z.array(TriageItem).default([]),
});

export type IngestPayload = z.infer<typeof IngestPayload>;
```

`IngestPayload` is the spine; everything validates against it.

Example payload (note the added `title`):

```json
{
  "session": { "author": "andres", "ended_at": "ISO8601", "skill_version": "1.0" },
  "feed_entries": [
    { "summary": "...", "body": "...", "tags": ["auth"],
      "artifacts": { "prs": [], "commits": [] } }
  ],
  "doc_proposals": [
    { "slug": "architecture", "section": "reference", "title": "Architecture",
      "body": "...(markdown or mermaid)...",
      "change_summary": "...", "confidence": "high|low" }
  ],
  "adr_drafts": [
    { "title": "...", "context": "...", "decision": "...",
      "rationale": "...", "confidence": "high|low" }
  ],
  "needs_triage": [
    { "raw": "...", "reason": "ambiguous section" }
  ]
}
```

## 6. Vocabulary (shared/vocabulary.ts)

Seeded in one editable file, trivial to edit:

```ts
export const SECTIONS = ["reference", "context", "decisions", "needs-triage"] as const;
export const TAGS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;
// starter tags — edit freely

export type Section = (typeof SECTIONS)[number];
export type Tag = string; // tags are validated against TAGS at runtime, not the type level
```

The same vocabulary is also seeded into the D1 `sections` and `tags` tables via
`0002_seed_vocab.sql`. `shared/vocabulary.ts` is the source the consumer's gate checks
against at runtime.

## 7. D1 schema (migrations/0001_init.sql)

```sql
CREATE TABLE sections (name TEXT PRIMARY KEY, description TEXT);
CREATE TABLE tags (tag TEXT PRIMARY KEY, description TEXT);

CREATE TABLE docs (
  slug TEXT PRIMARY KEY,
  section TEXT NOT NULL REFERENCES sections(name),
  title TEXT NOT NULL,
  body TEXT NOT NULL,                          -- markdown, or mermaid/d2 for diagrams
  current_version INTEGER NOT NULL DEFAULT 0,  -- 0 = nothing promoted yet
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE doc_versions (                    -- every version, staged or promoted, non-destructive
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES docs(slug),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,                                -- what changed and why
  status TEXT NOT NULL DEFAULT 'staged',       -- 'staged' | 'promoted'
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE feed (                            -- append-only working memory
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  artifacts TEXT,                              -- json
  created_at TEXT NOT NULL
);

CREATE TABLE adrs (                            -- decisions, drafted then ratified
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  context TEXT, decision TEXT, rationale TEXT,
  status TEXT NOT NULL DEFAULT 'draft',        -- 'draft' | 'ratified'
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE entry_tags (
  tag TEXT NOT NULL REFERENCES tags(tag),
  entry_type TEXT NOT NULL,                    -- 'doc' | 'feed' | 'adr'
  entry_id TEXT NOT NULL,
  PRIMARY KEY (tag, entry_type, entry_id)
);

CREATE TABLE needs_triage (                    -- anything the consumer could not place
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,                           -- json of the original item
  reason TEXT NOT NULL,
  source_author TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

`shared/rows.ts` declares one TypeScript type per table, matching these columns
exactly. `db.ts` query helpers return those types.

## 8. Data flow

```
session JSON --POST /ingest--> validate envelope (Zod IngestPayload)
                                   |  CLEAN SEAM: today calls consumer(payload, env) directly;
                                   |  a Queue producer.send(payload) drops in here later with no
                                   |  change to the consumer signature.
                                   v
                              consumer(payload, env)
   feed_entries   -> all tags in-vocab?  yes: append_feed + link entry_tags
                                          no : route_triage (reason: "unknown tag: X")
   doc_proposals  -> section in-vocab AND confidence === "high"?
                       yes: propose_doc_update (new staged version, current_version untouched)
                       no : route_triage (reason: out-of-vocab section / low confidence)
   adr_drafts     -> confidence === "high"?  yes: stage_adr (status 'draft')   no: route_triage
   needs_triage[] -> insert needs_triage rows directly
```

`created_at` / `updated_at` are stamped with `new Date().toISOString()` at write time
inside the Worker (allowed in the Workers runtime). `source_author` on triage rows and
`author` / `created_by` everywhere come from `session.author`.

## 9. Consumer rules (judgment calls, confirmed)

- **Feed out-of-vocab tag:** if a feed entry has **any** tag not in `TAGS`, the **whole
  entry** routes to `needs_triage` (reason names the unknown tag); it is not written to
  `feed`. In-vocab entries are appended directly and each tag is linked in `entry_tags`
  (`entry_type='feed'`, `entry_id` = new feed row id).
- **Doc title resolution (consumer, not schema):** `proposal.title ?? existing
  docs.title ?? humanizeSlug(slug)`. The humanize fallback applies **only on first
  creation** and never overwrites a title a human may have set on an existing doc.

  ```ts
  const humanizeSlug = (slug: string) =>
    slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  ```

- **Doc section on existing docs:** set on first creation only; later proposals do not
  rewrite the section.

## 10. Non-destructive doc write (exact behavior)

For a doc_proposal with slug `S` that passes the gate:

1. If no `docs` row for `S`: insert one with `section`, resolved `title`, `body=''`,
   `current_version=0`, `updated_at`/`updated_by` set. (`body=''` until a human
   promotes a version into it. `''` satisfies `NOT NULL`.)
2. Compute `version = max(doc_versions.version where slug=S) + 1` (1 for the first).
3. Insert a `doc_versions` row: `slug=S`, `version`, `body=proposal.body`,
   `summary=change_summary`, `status='staged'`, `confidence`, `created_at`,
   `created_by=session.author`.
4. **Do not touch `docs.current_version`.** Staged content lives only in
   `doc_versions`. Promotion (copying a version body into `docs.body` and bumping
   `current_version`) is a human action, out of scope for v1.

## 11. Read functions (src/tools/, also HTTP routes)

- `get_doc(slug)` → `docs` row + its `doc_versions` array.
- `list_docs(section?)` → docs, optionally filtered by section.
- `get_feed({ author?, tags?, since?, limit? })` → feed rows; `tags` filter via
  `entry_tags` join; `since` filters `created_at >=`; `limit` defaults to 50.
- `search_context(query, filters)` → simple D1 `LIKE '%query%'` match across
  `docs` (title/body), `feed` (summary/body), `adrs` (title/context/decision).
  Vectorize / semantic search is **deferred** — this function is the seam.

HTTP routes (Hono): `GET /doc/:slug`, `GET /docs?section=`,
`GET /feed?author=&tags=&since=&limit=`, `GET /search?q=&section=`.

## 12. MCP server (src/mcp.ts)

Stateless `createMcpHandler` from `agents/mcp`. No `McpAgent`, no Durable Object.

- A **fresh** `McpServer` instance is constructed **inside the request handler**
  (MCP SDK 1.26+ guards against reused instances), never in global scope.
- Tools registered as thin wrappers over `src/tools`: `get_doc`, `list_docs`,
  `get_feed`, `search_context`, `append_feed`, `propose_doc_update`. Each tool's Zod
  input schema is derived from / consistent with `shared/contract.ts`.
- `const handler = createMcpHandler(server, { route: "/mcp" }); return handler(request, env, ctx);`
- Mounted at `/mcp` on the same origin — a Claude Code connects by URL. No auth (deferred).

Verified API (agents@0.16.2):
`createMcpHandler(server: McpServer, options?: { route?: string; ... }) => (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>`.

## 13. Worker entry & same-origin wiring (src/index.ts)

```
fetch(request, env, ctx):
  url = new URL(request.url)
  if url.pathname === "/mcp": return mcpHandler(request, env, ctx)
  return app.fetch(request, env, ctx)   // Hono: /ingest + read routes
```

`wrangler.toml` declares an **assets binding** pointing at `web/dist`. Static assets
are served by the assets layer **before** the Worker fetch handler runs, so `/` serves
the built site and `/ingest`, `/feed`, `/mcp`, etc. fall through to the Worker. One
origin, one deploy, no CORS.

## 14. Tests (Vitest + @cloudflare/vitest-pool-workers, real Miniflare D1)

Exactly the two the spec names. Migrations are applied to the test D1 before the run.

1. **Vocab gate:** an in-vocab feed entry lands in `feed` (and `entry_tags`); an
   out-of-vocab tag (and a low-confidence / out-of-vocab doc) lands in `needs_triage`
   instead — nothing guessed.
2. **Non-destructive doc write:** a doc_proposal inserts a `doc_versions` row with
   `status='staged'` and `version = max+1`, and leaves `docs.current_version`
   unchanged (0).

## 15. Deferred (seams left, NOT built)

- **Cloudflare Queue** — seam at `/ingest` → `consumer(payload, env)`; swap the direct
  call for `producer.send(payload)` + a queue consumer later, no consumer change.
- **Vectorize embeddings / semantic search** — seam in `search_context`; text `LIKE`
  match is fine for v1.
- **Auth** — none on any route for v1.
- **The real frontend** — `web/` is a placeholder smoke test only.
- **The session-end skill** — out of scope.

## 16. Build order

Repo + wrangler config (D1 + assets bindings) → schema + migration → `shared/`
contract + vocab + row types → write path with the vocabulary gate → read functions +
their HTTP routes → MCP wrapper → placeholder `web/` page last.

## 17. Parallel / subagent execution strategy

Maximize safe parallelism without write conflicts; file ownership is disjoint per
phase, so `worktree` isolation is not needed.

- **Phase 0 — Foundation (1 agent, sequential, blocks all):** scaffold repo,
  `package.json`, `tsconfig` with `@shared/*`, `wrangler.toml` (D1 + assets bindings),
  `vitest.config.ts`.
- **Phase 1 — Contracts (2 agents, parallel):** Agent A → `migrations/*.sql` (schema +
  seed vocab); Agent B → `shared/` (contract, vocabulary, rows). Independent files
  (SQL vs TS); both work from this fixed spec, so they cannot drift.
- **Phase 2 — DB layer (1 agent):** `src/db.ts` typed helpers — depends on
  `shared/rows.ts` + schema.
- **Phase 3 — Logic (2 agents, parallel):** Agent C → `src/tools/` (reads + write
  primitives) + read HTTP routes; Agent D → `src/consumer.ts` (vocab gate + fan-out) +
  `/ingest` route + both Vitest tests (TDD). Separate files; tool signatures are fixed
  by this design, so D codes against them.
- **Phase 4 — Adapters (2 agents, parallel):** Agent E → `src/mcp.ts` + wire
  `src/index.ts`; Agent F → `web/` Vite placeholder. Independent.
- **Phase 5 — Integration (1 agent, sequential):** `wrangler dev`, apply migrations,
  run the suite, hit `/feed` and `/mcp` end-to-end, fix wiring.

Each agent receives a self-contained task slice naming the exact files it owns and the
interfaces it depends on.
