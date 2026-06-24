# Sapling Context Store — Backend (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data + Worker layer of the Sapling context store — one Cloudflare Worker on one origin that validates a session JSON payload, writes it to D1 under a controlled-vocabulary gate, exposes read functions over HTTP and MCP, and serves a placeholder web build via the assets binding.

**Architecture:** One repo, one Worker, one origin. `shared/` holds the Zod contract, the vocabulary, and the D1 row types, imported by both `src/` (the Worker) and `web/` (the frontend) so the schema can never drift. The Worker validates structure and writes; it never re-interprets meaning. Static assets are served by the Workers assets binding; non-asset requests fall through to the Worker (`/ingest`, `/feed`, `/mcp`, …). The frontend touches the Worker only over HTTP — never importing `src/`.

**Tech Stack:** Cloudflare Workers, Hono, D1, TypeScript, Wrangler; Zod for validation; `agents/mcp` `createMcpHandler` + `@modelcontextprotocol/sdk` for a stateless MCP server; Vite for the web build; Vitest + `@cloudflare/vitest-pool-workers` for tests (real Miniflare D1).

## Global Constraints

These apply to every task; copy values verbatim.

- **Runtime/tooling versions (verified compatible):**
  - Dependencies: `hono@^4.12.0`, `zod@^3.25.0`, `agents@^0.16.2`, `@modelcontextprotocol/sdk@^1.29.0`
  - Dev: `wrangler@^4.84.0`, `typescript@^5.6.0`, `vite@^6.0.0`, `vitest@^4.1.0`, `@cloudflare/vitest-pool-workers@^0.16.0`, `@cloudflare/workers-types@^4.0.0`
  - `vitest@^4.1` is **required** by `@cloudflare/vitest-pool-workers@^0.16` (peer). `zod@^3.25` is **required** by the MCP SDK. Do not downgrade either.
- **One origin, one deploy:** API routes, the MCP endpoint, and the static site are all served by the single Worker. No CORS handling anywhere.
- **Boundary discipline:** `web/` imports only from `shared/`. It NEVER imports anything under `src/`. The HTTP API is the only runtime contact between the two.
- **shared/ is the only shared code.** The contract, vocabulary, and row types live there and nowhere else. Do not duplicate them into `src/` or `web/`.
- **Worker validates structure, never meaning.** `/ingest` validates the envelope with Zod and runs the consumer; it does not re-interpret content.
- **Controlled vocabulary:** sections and tags are fixed lists. Out-of-vocabulary or low-confidence items route to `needs_triage` — never guessed.
- **Doc writes are non-destructive:** insert a new `doc_versions` row (`status='staged'`); never touch `docs.current_version` (promotion is a human action, out of scope).
- **Strong types throughout.** `tsc` must pass with `strict: true`.
- **Module separation (required):** `shared` (contract, vocab, types); in `src`: `routes`, `consumer`, `db`, `tools`, `mcp`.
- **Deferred (leave seams, do not build):** Cloudflare Queue (seam at `/ingest`→`consume()`), Vectorize/semantic search (seam in `search_context`), auth, the real frontend, the session-end skill.

## Parallelization Map (for subagent-driven execution)

File ownership is disjoint within each parallel group, so concurrent agents never edit the same file. `worktree` isolation is not needed.

- **Phase 0 — Task 1** (Foundation): sequential, blocks everything.
- **Phase 1 — Tasks 2 + 3** (Migrations ∥ Shared): parallel. Both depend only on Task 1.
- **Phase 2 — Task 4** (DB layer): depends on Task 3.
- **Phase 3 — Tasks 5 + 6** (Reads ∥ Writes): parallel. Both depend on Tasks 3 + 4.
- **Phase 4 — Task 7** (Consumer): depends on Task 6 + Task 3.
- **Phase 5 — Tasks 8 + 9 + 11** (Routes ∥ MCP ∥ Web): parallel. 8 depends on 5+7; 9 depends on 5+6; 11 depends only on Task 1.
- **Phase 6 — Task 10** (Worker entry wiring): depends on Tasks 8 + 9.
- **Phase 7 — Task 12** (Integration): sequential, last. Depends on everything.

## File Structure

```
sapling-context/
  package.json            scripts + pinned deps
  tsconfig.json           base: paths (@shared/*), strict
  tsconfig.worker.json    src/shared/test, workers-types
  tsconfig.web.json       web/shared, DOM lib
  wrangler.toml           D1 binding (DB), assets binding (ASSETS -> web/dist)
  vitest.config.ts        vitest-pool-workers, reads migrations
  .gitignore
  README.md
  migrations/
    0001_init.sql          all tables (verbatim schema)
    0002_seed_vocab.sql    sections + starter tags (mirrors shared/vocabulary.ts)
  shared/
    contract.ts            Zod envelope + inferred IngestPayload
    vocabulary.ts          SECTIONS, TAGS, isSection(), isTag()
    rows.ts                one TS type per D1 table
  src/
    env.ts                 Env interface (DB, ASSETS)
    db.ts                  first/all/run helpers + nowIso()
    tools/
      reads.ts             get_doc, list_docs, get_feed, search_context
      writes.ts            append_feed, propose_doc_update, stage_adr, route_triage
    consumer.ts            consume(db, payload): vocab gate + fan-out
    routes.ts              Hono app: /ingest + read routes
    mcp.ts                 handleMcp(): stateless createMcpHandler
    index.ts               Worker entry: /mcp -> handleMcp; else Hono
  web/
    index.html             placeholder shell
    src/main.ts            imports @shared, fetches /feed, dumps JSON
    vite.config.ts         builds to web/dist, @shared alias
  test/
    env.d.ts               cloudflare:test ProvidedEnv augmentation
    apply-migrations.ts    setup: applyD1Migrations
    doc-write.nondestructive.test.ts
    consumer.vocab-gate.test.ts
```

---

## Task 1: Project foundation (scaffold, config, bindings)

**Phase 0 — sequential, blocks all.**

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.worker.json`, `tsconfig.web.json`, `wrangler.toml`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `test/env.d.ts`, `test/apply-migrations.ts`
- Create (stub so configs resolve): `migrations/.gitkeep`, `web/dist/.gitkeep`

**Interfaces:**
- Produces: the `@shared/*` path alias; npm scripts `test`, `typecheck`, `build:web`, `dev`, `deploy`, `db:*`; the `cloudflare:test` `ProvidedEnv` with `DB` + `TEST_MIGRATIONS`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "sapling-context",
  "private": true,
  "type": "module",
  "scripts": {
    "build:web": "vite build --config web/vite.config.ts",
    "dev": "npm run build:web && wrangler dev",
    "deploy": "npm run build:web && wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json",
    "db:create": "wrangler d1 create sapling-context",
    "db:migrate:local": "wrangler d1 migrations apply sapling-context --local",
    "db:migrate:remote": "wrangler d1 migrations apply sapling-context --remote"
  },
  "dependencies": {
    "hono": "^4.12.0",
    "zod": "^3.25.0",
    "agents": "^0.16.2",
    "@modelcontextprotocol/sdk": "^1.29.0"
  },
  "devDependencies": {
    "wrangler": "^4.84.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^4.1.0",
    "@cloudflare/vitest-pool-workers": "^0.16.0",
    "@cloudflare/workers-types": "^4.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes with no peer-dependency ERROR (warnings OK). If npm reports a `vitest` peer conflict, the pinned `vitest@^4.1.0` already satisfies `@cloudflare/vitest-pool-workers@^0.16` — re-check the versions above before changing anything.

- [ ] **Step 3: Create the TypeScript configs**

`tsconfig.json` (base):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["shared/*"] }
  }
}
```

`tsconfig.worker.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "shared", "test", "vitest.config.ts"]
}
```

`tsconfig.web.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["web/src", "shared", "web/vite.config.ts"]
}
```

- [ ] **Step 4: Create `wrangler.toml`**

```toml
name = "sapling-context"
main = "src/index.ts"
compatibility_date = "2025-11-01"
compatibility_flags = ["nodejs_compat"]

# Static Assets: served before the Worker fetch handler. Matched files (e.g. "/")
# are returned directly; unmatched paths (/ingest, /feed, /mcp) fall through to src/index.ts.
[assets]
directory = "./web/dist"
binding = "ASSETS"

# D1. For local dev and tests the id is a placeholder (Miniflare uses a local sqlite).
# Run `npm run db:create` to provision the real database and paste its id here before deploy.
[[d1_databases]]
binding = "DB"
database_name = "sapling-context"
database_id = "00000000-0000-0000-0000-000000000000"

[observability]
enabled = true
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // exposed to tests as env.TEST_MIGRATIONS; applied in the setup file
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

- [ ] **Step 6: Create the test env types and migration setup**

`test/env.d.ts`:
```ts
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

`test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before the suite. applyD1Migrations is idempotent.
// With isolated per-test storage, the seeded schema is visible to every test
// while each test's own writes roll back.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 7: Create `.gitignore`, `README.md`, and config-resolving stubs**

`.gitignore`:
```
node_modules/
web/dist/
.wrangler/
.dev.vars
*.log
```

`README.md`:
```markdown
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
```

Then create empty stubs so `[assets]` and the migrations dir resolve before later tasks fill them:
- `migrations/.gitkeep` (empty)
- `web/dist/.gitkeep` (empty)

- [ ] **Step 8: Verify the toolchain compiles**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0 (no `src/shared/test` files reference missing modules yet; `test/*.ts` type-check against the `cloudflare:test` ambient module). If `cloudflare:test` is "cannot find module", confirm `@cloudflare/vitest-pool-workers` is in `tsconfig.worker.json` `types`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold sapling-context repo, config, and D1/assets bindings"
```

---

## Task 2: D1 schema + vocabulary seed migrations

**Phase 1 — parallel with Task 3.**

**Files:**
- Create: `migrations/0001_init.sql`, `migrations/0002_seed_vocab.sql`
- Remove: `migrations/.gitkeep`

**Interfaces:**
- Produces: the D1 tables (`sections`, `tags`, `docs`, `doc_versions`, `feed`, `adrs`, `entry_tags`, `needs_triage`) and the seeded vocabulary. The seeded tag/section lists MUST be identical to `shared/vocabulary.ts` (Task 3).

- [ ] **Step 1: Create `migrations/0001_init.sql`**

```sql
CREATE TABLE sections (name TEXT PRIMARY KEY, description TEXT);
CREATE TABLE tags (tag TEXT PRIMARY KEY, description TEXT);

CREATE TABLE docs (
  slug TEXT PRIMARY KEY,
  section TEXT NOT NULL REFERENCES sections(name),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES docs(slug),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  artifacts TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE adrs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  context TEXT, decision TEXT, rationale TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE entry_tags (
  tag TEXT NOT NULL REFERENCES tags(tag),
  entry_type TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (tag, entry_type, entry_id)
);

CREATE TABLE needs_triage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_author TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_doc_versions_slug ON doc_versions(slug);
CREATE INDEX idx_feed_created_at ON feed(created_at);
CREATE INDEX idx_entry_tags_lookup ON entry_tags(entry_type, entry_id);
```

- [ ] **Step 2: Create `migrations/0002_seed_vocab.sql`**

```sql
INSERT INTO sections (name, description) VALUES
  ('reference', 'Stable reference docs and architecture'),
  ('context', 'Working context and background'),
  ('decisions', 'Architecture decision records'),
  ('needs-triage', 'Catch-all for items needing human placement');

INSERT INTO tags (tag, description) VALUES
  ('auth', 'Authentication and authorization'),
  ('architecture', 'System architecture and structure'),
  ('infra', 'Infrastructure and deployment'),
  ('api', 'API surface and routes'),
  ('ui', 'Frontend and UI'),
  ('data', 'Data model and storage');
```

- [ ] **Step 3: Remove the stub**

Run: `git rm migrations/.gitkeep`

- [ ] **Step 4: Verify the SQL applies cleanly to a local D1**

Run: `npx wrangler d1 migrations apply sapling-context --local`
Expected: reports 2 migrations applied with no SQL error. (Uses the local Miniflare sqlite under `.wrangler/`.)

- [ ] **Step 5: Commit**

```bash
git add migrations
git commit -m "feat: add D1 schema and vocabulary seed migrations"
```

---

## Task 3: Shared contract, vocabulary, and row types

**Phase 1 — parallel with Task 2.**

**Files:**
- Create: `shared/contract.ts`, `shared/vocabulary.ts`, `shared/rows.ts`

**Interfaces:**
- Produces:
  - `shared/contract.ts`: `IngestPayload` (Zod schema + inferred type), and the part schemas `Session`, `FeedEntry`, `DocProposal`, `AdrDraft`, `TriageItem`.
  - `shared/vocabulary.ts`: `SECTIONS`, `TAGS` (readonly arrays), `Section` type, `isSection(s: string): s is Section`, `isTag(t: string): boolean`.
  - `shared/rows.ts`: `SectionRow`, `TagRow`, `DocRow`, `DocVersionRow`, `FeedRow`, `AdrRow`, `EntryTagRow`, `NeedsTriageRow`.
- The `TAGS`/`SECTIONS` values MUST match `migrations/0002_seed_vocab.sql` (Task 2).

- [ ] **Step 1: Create `shared/vocabulary.ts`**

```ts
// Controlled vocabulary — the single editable source of truth for the gate.
// These values MUST match migrations/0002_seed_vocab.sql.
export const SECTIONS = ["reference", "context", "decisions", "needs-triage"] as const;
export const TAGS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;

export type Section = (typeof SECTIONS)[number];

export const isSection = (s: string): s is Section =>
  (SECTIONS as readonly string[]).includes(s);

export const isTag = (t: string): boolean =>
  (TAGS as readonly string[]).includes(t);
```

- [ ] **Step 2: Create `shared/contract.ts`**

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
  title: z.string().optional(),          // session sends a real title when it has one
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

export type Session = z.infer<typeof Session>;
export type FeedEntry = z.infer<typeof FeedEntry>;
export type DocProposal = z.infer<typeof DocProposal>;
export type AdrDraft = z.infer<typeof AdrDraft>;
export type TriageItem = z.infer<typeof TriageItem>;
export type IngestPayload = z.infer<typeof IngestPayload>;
```

- [ ] **Step 3: Create `shared/rows.ts`**

```ts
// One type per D1 table — the exact row shape returned by db helpers.
export interface SectionRow { name: string; description: string | null; }
export interface TagRow { tag: string; description: string | null; }

export interface DocRow {
  slug: string;
  section: string;
  title: string;
  body: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface DocVersionRow {
  id: number;
  slug: string;
  version: number;
  body: string;
  summary: string | null;
  status: "staged" | "promoted";
  confidence: string | null;
  created_at: string;
  created_by: string;
}

export interface FeedRow {
  id: number;
  author: string;
  summary: string;
  body: string | null;
  artifacts: string | null;
  created_at: string;
}

export interface AdrRow {
  id: number;
  title: string;
  context: string | null;
  decision: string | null;
  rationale: string | null;
  status: "draft" | "ratified";
  confidence: string | null;
  created_at: string;
  created_by: string;
}

export interface EntryTagRow {
  tag: string;
  entry_type: "doc" | "feed" | "adr";
  entry_id: string;
}

export interface NeedsTriageRow {
  id: number;
  raw: string;
  reason: string;
  source_author: string | null;
  resolved: number;
  created_at: string;
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add shared
git commit -m "feat: add shared Zod contract, vocabulary, and D1 row types"
```

---

## Task 4: DB helper layer

**Phase 2 — depends on Task 3.**

**Files:**
- Create: `src/env.ts`, `src/db.ts`

**Interfaces:**
- Produces:
  - `src/env.ts`: `interface Env { DB: D1Database; ASSETS: Fetcher; }`
  - `src/db.ts`: `type DB = D1Database`; `first<T>(db, query, ...params): Promise<T | null>`; `all<T>(db, query, ...params): Promise<T[]>`; `run(db, query, ...params): Promise<D1Result>`; `nowIso(): string`.
- Consumes: nothing (low-level).

- [ ] **Step 1: Create `src/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}
```

- [ ] **Step 2: Create `src/db.ts`**

```ts
export type DB = D1Database;

/** Current time as an ISO8601 string. Allowed in the Workers runtime. */
export const nowIso = (): string => new Date().toISOString();

/** First row of a query, or null. */
export async function first<T>(db: DB, query: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(query).bind(...params).first<T>()) ?? null;
}

/** All rows of a query (empty array if none). */
export async function all<T>(db: DB, query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(query).bind(...params).all<T>();
  return results ?? [];
}

/** Run a write and return the D1 result (use res.meta.last_row_id for inserts). */
export async function run(db: DB, query: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(query).bind(...params).run();
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/env.ts src/db.ts
git commit -m "feat: add typed D1 helper layer and Env interface"
```

---

## Task 5: Read tools

**Phase 3 — parallel with Task 6.**

**Files:**
- Create: `src/tools/reads.ts`

**Interfaces:**
- Consumes: `src/db.ts` (`DB`, `first`, `all`); `@shared/rows` types.
- Produces:
  - `get_doc(db: DB, slug: string): Promise<{ doc: DocRow; versions: DocVersionRow[] } | null>`
  - `list_docs(db: DB, section?: string): Promise<DocRow[]>`
  - `interface FeedFilter { author?: string; tags?: string[]; since?: string; limit?: number; }`
  - `get_feed(db: DB, filter?: FeedFilter): Promise<FeedRow[]>`
  - `interface SearchResult { type: "doc" | "feed" | "adr"; id: string; title: string; snippet: string; }`
  - `interface SearchFilters { section?: string; limit?: number; }`
  - `search_context(db: DB, query: string, filters?: SearchFilters): Promise<SearchResult[]>`

- [ ] **Step 1: Create `src/tools/reads.ts`**

```ts
import type { DocRow, DocVersionRow, FeedRow, AdrRow } from "@shared/rows";
import { type DB, first, all } from "../db";

export async function get_doc(
  db: DB,
  slug: string
): Promise<{ doc: DocRow; versions: DocVersionRow[] } | null> {
  const doc = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, slug);
  if (!doc) return null;
  const versions = await all<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? ORDER BY version ASC`,
    slug
  );
  return { doc, versions };
}

export async function list_docs(db: DB, section?: string): Promise<DocRow[]> {
  if (section) {
    return all<DocRow>(db, `SELECT * FROM docs WHERE section = ? ORDER BY slug ASC`, section);
  }
  return all<DocRow>(db, `SELECT * FROM docs ORDER BY slug ASC`);
}

export interface FeedFilter {
  author?: string;
  tags?: string[];
  since?: string;
  limit?: number;
}

export async function get_feed(db: DB, filter: FeedFilter = {}): Promise<FeedRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let join = "";

  if (filter.author) {
    clauses.push(`f.author = ?`);
    params.push(filter.author);
  }
  if (filter.since) {
    clauses.push(`f.created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.tags && filter.tags.length > 0) {
    const placeholders = filter.tags.map(() => "?").join(", ");
    join = `JOIN entry_tags et ON et.entry_type = 'feed'
            AND et.entry_id = CAST(f.id AS TEXT) AND et.tag IN (${placeholders})`;
    params.push(...filter.tags);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Clamp to a safe integer; interpolated (not bound) because SQLite rejects bound LIMIT in some drivers.
  const limit = Math.trunc(Math.min(Math.max(filter.limit ?? 50, 1), 500));

  return all<FeedRow>(
    db,
    `SELECT DISTINCT f.* FROM feed f ${join} ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`,
    ...params
  );
}

export interface SearchResult {
  type: "doc" | "feed" | "adr";
  id: string;
  title: string;
  snippet: string;
}

export interface SearchFilters {
  section?: string;
  limit?: number;
}

// Simple D1 text match for v1. SEAM: Vectorize / semantic search is deferred and
// would slot in here without changing the signature.
export async function search_context(
  db: DB,
  query: string,
  filters: SearchFilters = {}
): Promise<SearchResult[]> {
  const like = `%${query}%`;
  const limit = Math.trunc(Math.min(Math.max(filters.limit ?? 25, 1), 200));
  const results: SearchResult[] = [];

  const docParams: unknown[] = [like, like];
  let docSection = "";
  if (filters.section) {
    docSection = ` AND section = ?`;
    docParams.push(filters.section);
  }
  const docs = await all<DocRow>(
    db,
    `SELECT * FROM docs WHERE (title LIKE ? OR body LIKE ?)${docSection} LIMIT ${limit}`,
    ...docParams
  );
  for (const d of docs) {
    results.push({ type: "doc", id: d.slug, title: d.title, snippet: d.body.slice(0, 200) });
  }

  // feed and adrs have no section; only included when no section filter is set.
  if (!filters.section) {
    const feed = await all<FeedRow>(
      db,
      `SELECT * FROM feed WHERE summary LIKE ? OR body LIKE ? LIMIT ${limit}`,
      like,
      like
    );
    for (const f of feed) {
      results.push({ type: "feed", id: String(f.id), title: f.summary, snippet: (f.body ?? "").slice(0, 200) });
    }

    const adrs = await all<AdrRow>(
      db,
      `SELECT * FROM adrs WHERE title LIKE ? OR context LIKE ? OR decision LIKE ? LIMIT ${limit}`,
      like,
      like,
      like
    );
    for (const a of adrs) {
      results.push({ type: "adr", id: String(a.id), title: a.title, snippet: (a.decision ?? "").slice(0, 200) });
    }
  }

  return results;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/tools/reads.ts
git commit -m "feat: add read tools (get_doc, list_docs, get_feed, search_context)"
```

---

## Task 6: Write tools (TDD: non-destructive doc write)

**Phase 3 — parallel with Task 5.** This task includes the required **non-destructive doc write** test.

**Files:**
- Create: `src/tools/writes.ts`
- Test: `test/doc-write.nondestructive.test.ts`

**Interfaces:**
- Consumes: `src/db.ts` (`DB`, `first`, `run`, `nowIso`); `@shared/rows` (`DocRow`).
- Produces:
  - `append_feed(db, entry: { author: string; summary: string; body?: string; artifacts?: unknown; tags?: string[] }): Promise<number>` (returns feed row id)
  - `propose_doc_update(db, proposal: { slug: string; section: string; title?: string; body: string; change_summary: string; confidence: "high" | "low" }, author: string): Promise<{ slug: string; version: number; status: "staged" }>`
  - `stage_adr(db, draft: { title: string; context: string; decision: string; rationale: string; confidence: "high" | "low" }, author: string): Promise<number>` (returns adr row id)
  - `route_triage(db, item: { raw: unknown; reason: string; source_author?: string }): Promise<number>` (returns triage row id)

- [ ] **Step 1: Write the failing test**

`test/doc-write.nondestructive.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { propose_doc_update } from "../src/tools/writes";
import { first, all } from "../src/db";
import type { DocRow, DocVersionRow } from "@shared/rows";

describe("non-destructive doc write", () => {
  it("stages v1, creates the doc with empty body, leaves current_version at 0", async () => {
    const proposal = {
      slug: "architecture",
      section: "reference",
      title: "Architecture",
      body: "# v1 body",
      change_summary: "initial draft",
      confidence: "high" as const,
    };

    const out = await propose_doc_update(env.DB, proposal, "andres");
    expect(out).toEqual({ slug: "architecture", version: 1, status: "staged" });

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(0);
    expect(doc?.body).toBe("");
    expect(doc?.title).toBe("Architecture");

    const versions = await all<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = ? ORDER BY version`,
      "architecture"
    );
    expect(versions.length).toBe(1);
    expect(versions[0].status).toBe("staged");
    expect(versions[0].version).toBe(1);
    expect(versions[0].body).toBe("# v1 body");
  });

  it("derives a humanized title when the proposal omits one", async () => {
    const out = await propose_doc_update(
      env.DB,
      { slug: "auth-flow", section: "reference", body: "x", change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(out.version).toBe(1);
    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "auth-flow");
    expect(doc?.title).toBe("Auth Flow");
  });

  it("appends v2 on a second proposal and still promotes nothing", async () => {
    const base = { slug: "architecture", section: "reference", title: "Architecture", confidence: "high" as const };
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    const second = await propose_doc_update(env.DB, { ...base, body: "# v2", change_summary: "second" }, "andres");
    expect(second.version).toBe(2);

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(0);
    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ?`, "architecture");
    expect(versions.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/doc-write.nondestructive.test.ts`
Expected: FAIL — cannot resolve `../src/tools/writes` (module does not exist yet).

- [ ] **Step 3: Write `src/tools/writes.ts`**

```ts
import type { DocRow } from "@shared/rows";
import { type DB, first, run, nowIso } from "../db";

const humanizeSlug = (slug: string): string =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function append_feed(
  db: DB,
  entry: { author: string; summary: string; body?: string; artifacts?: unknown; tags?: string[] }
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, ?, ?, ?, ?)`,
    entry.author,
    entry.summary,
    entry.body ?? null,
    entry.artifacts !== undefined ? JSON.stringify(entry.artifacts) : null,
    created_at
  );
  const id = res.meta.last_row_id as number;
  for (const tag of entry.tags ?? []) {
    await run(
      db,
      `INSERT OR IGNORE INTO entry_tags (tag, entry_type, entry_id) VALUES (?, 'feed', ?)`,
      tag,
      String(id)
    );
  }
  return id;
}

export async function propose_doc_update(
  db: DB,
  proposal: {
    slug: string;
    section: string;
    title?: string;
    body: string;
    change_summary: string;
    confidence: "high" | "low";
  },
  author: string
): Promise<{ slug: string; version: number; status: "staged" }> {
  const created_at = nowIso();
  const existing = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, proposal.slug);

  if (!existing) {
    // Title resolution on first creation only: proposal.title ?? humanizeSlug(slug).
    // (On an existing doc we never rewrite title/section — a human may have set them.)
    const title = proposal.title ?? humanizeSlug(proposal.slug);
    await run(
      db,
      `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by)
       VALUES (?, ?, ?, '', 0, ?, ?)`,
      proposal.slug,
      proposal.section,
      title,
      created_at,
      author
    );
  }

  const max = await first<{ v: number | null }>(
    db,
    `SELECT MAX(version) AS v FROM doc_versions WHERE slug = ?`,
    proposal.slug
  );
  const version = (max?.v ?? 0) + 1;

  await run(
    db,
    `INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by)
     VALUES (?, ?, ?, ?, 'staged', ?, ?, ?)`,
    proposal.slug,
    version,
    proposal.body,
    proposal.change_summary,
    proposal.confidence,
    created_at,
    author
  );

  // docs.current_version intentionally untouched — promotion is a human action (out of scope).
  return { slug: proposal.slug, version, status: "staged" };
}

export async function stage_adr(
  db: DB,
  draft: { title: string; context: string; decision: string; rationale: string; confidence: "high" | "low" },
  author: string
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    draft.title,
    draft.context,
    draft.decision,
    draft.rationale,
    draft.confidence,
    created_at,
    author
  );
  return res.meta.last_row_id as number;
}

export async function route_triage(
  db: DB,
  item: { raw: unknown; reason: string; source_author?: string }
): Promise<number> {
  const created_at = nowIso();
  const raw = typeof item.raw === "string" ? item.raw : JSON.stringify(item.raw);
  const res = await run(
    db,
    `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    raw,
    item.reason,
    item.source_author ?? null,
    created_at
  );
  return res.meta.last_row_id as number;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/doc-write.nondestructive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/writes.ts test/doc-write.nondestructive.test.ts
git commit -m "feat: add write tools with non-destructive doc staging (TDD)"
```

---

## Task 7: Consumer (TDD: vocabulary gate)

**Phase 4 — depends on Task 6 + Task 3.** This task includes the required **vocab gate** test.

**Files:**
- Create: `src/consumer.ts`
- Test: `test/consumer.vocab-gate.test.ts`

**Interfaces:**
- Consumes: `@shared/contract` (`IngestPayload`), `@shared/vocabulary` (`isSection`, `isTag`), `src/db.ts` (`DB`), `src/tools/writes.ts` (`append_feed`, `propose_doc_update`, `stage_adr`, `route_triage`).
- Produces:
  - `interface IngestResult { feed: number; docs: number; adrs: number; triaged: number; }`
  - `consume(db: DB, payload: IngestPayload): Promise<IngestResult>`

- [ ] **Step 1: Write the failing test**

`test/consumer.vocab-gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { IngestPayload } from "@shared/contract";
import { consume } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { all } from "../src/db";
import type { NeedsTriageRow, DocVersionRow } from "@shared/rows";

const session = { author: "andres", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" };

describe("vocabulary gate", () => {
  it("writes in-vocab feed entries and routes out-of-vocab tags to needs_triage", async () => {
    const payload = IngestPayload.parse({
      session,
      feed_entries: [
        { summary: "known", body: "good", tags: ["auth"], artifacts: { prs: [], commits: [] } },
        { summary: "unknown", body: "bad", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [] } },
      ],
    });

    const result = await consume(env.DB, payload);
    expect(result.feed).toBe(1);
    expect(result.triaged).toBe(1);

    const feed = await get_feed(env.DB, {});
    expect(feed.some((f) => f.summary === "known")).toBe(true);
    expect(feed.some((f) => f.summary === "unknown")).toBe(false);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].reason).toContain("not-a-real-tag");
  });

  it("routes out-of-vocab doc sections and low-confidence items to triage, stages valid ones", async () => {
    const payload = IngestPayload.parse({
      session,
      doc_proposals: [
        { slug: "good-doc", section: "reference", body: "ok", change_summary: "s", confidence: "high" },
        { slug: "bad-section", section: "made-up", body: "x", change_summary: "s", confidence: "high" },
        { slug: "low-conf", section: "reference", body: "x", change_summary: "s", confidence: "low" },
      ],
      adr_drafts: [
        { title: "good adr", context: "c", decision: "d", rationale: "r", confidence: "high" },
        { title: "weak adr", context: "c", decision: "d", rationale: "r", confidence: "low" },
      ],
      needs_triage: [{ raw: "raw blob", reason: "ambiguous section" }],
    });

    const result = await consume(env.DB, payload);
    expect(result.docs).toBe(1);
    expect(result.adrs).toBe(1);
    // bad-section + low-conf doc + weak adr + explicit triage item = 4
    expect(result.triaged).toBe(4);

    const staged = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(staged.length).toBe(1);
    expect(staged[0].slug).toBe("good-doc");

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/consumer.vocab-gate.test.ts`
Expected: FAIL — cannot resolve `../src/consumer`.

- [ ] **Step 3: Write `src/consumer.ts`**

```ts
import type { IngestPayload } from "@shared/contract";
import { isSection, isTag } from "@shared/vocabulary";
import { type DB } from "./db";
import { append_feed, propose_doc_update, stage_adr, route_triage } from "./tools/writes";

export interface IngestResult {
  feed: number;
  docs: number;
  adrs: number;
  triaged: number;
}

/**
 * Validate-and-write the (already structurally-validated) payload.
 * The Worker verifies structure; this gate verifies vocabulary and confidence.
 * Nothing out-of-vocab or low-confidence is guessed — it goes to needs_triage.
 */
export async function consume(db: DB, payload: IngestPayload): Promise<IngestResult> {
  const author = payload.session.author;
  const result: IngestResult = { feed: 0, docs: 0, adrs: 0, triaged: 0 };

  // Feed: append-only, but any out-of-vocab tag routes the WHOLE entry to triage.
  for (const entry of payload.feed_entries) {
    const unknown = entry.tags.filter((t) => !isTag(t));
    if (unknown.length > 0) {
      await route_triage(db, { raw: entry, reason: `unknown tag: ${unknown.join(", ")}`, source_author: author });
      result.triaged++;
      continue;
    }
    await append_feed(db, {
      author,
      summary: entry.summary,
      body: entry.body,
      artifacts: entry.artifacts,
      tags: entry.tags,
    });
    result.feed++;
  }

  // Docs: section must be in-vocab AND confidence high; staged non-destructively.
  for (const proposal of payload.doc_proposals) {
    if (!isSection(proposal.section)) {
      await route_triage(db, { raw: proposal, reason: `out-of-vocab section: ${proposal.section}`, source_author: author });
      result.triaged++;
      continue;
    }
    if (proposal.confidence === "low") {
      await route_triage(db, { raw: proposal, reason: "low confidence doc proposal", source_author: author });
      result.triaged++;
      continue;
    }
    await propose_doc_update(db, proposal, author);
    result.docs++;
  }

  // ADRs: confidence high; staged as 'draft' for human ratification.
  for (const draft of payload.adr_drafts) {
    if (draft.confidence === "low") {
      await route_triage(db, { raw: draft, reason: "low confidence adr draft", source_author: author });
      result.triaged++;
      continue;
    }
    await stage_adr(db, draft, author);
    result.adrs++;
  }

  // Explicit triage items: written directly.
  for (const item of payload.needs_triage) {
    await route_triage(db, { raw: item.raw, reason: item.reason, source_author: author });
    result.triaged++;
  }

  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/consumer.vocab-gate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — both test files, 5 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/consumer.ts test/consumer.vocab-gate.test.ts
git commit -m "feat: add ingest consumer with vocabulary gate (TDD)"
```

---

## Task 8: HTTP routes (Hono)

**Phase 5 — parallel with Tasks 9 + 11.**

**Files:**
- Create: `src/routes.ts`

**Interfaces:**
- Consumes: `hono`; `@shared/contract` (`IngestPayload`); `src/env.ts` (`Env`); `src/consumer.ts` (`consume`); `src/tools/reads.ts` (`get_doc`, `list_docs`, `get_feed`, `search_context`).
- Produces: `export const app: Hono<{ Bindings: Env }>` with `POST /ingest`, `GET /docs`, `GET /doc/:slug`, `GET /feed`, `GET /search`.

- [ ] **Step 1: Create `src/routes.ts`**

```ts
import { Hono } from "hono";
import { IngestPayload } from "@shared/contract";
import type { Env } from "./env";
import { consume } from "./consumer";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";

export const app = new Hono<{ Bindings: Env }>();

app.post("/ingest", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = IngestPayload.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  // SEAM: today we call the consumer directly. A Cloudflare Queue producer.send(parsed.data)
  // would slot in here later with no change to consume()'s signature.
  const result = await consume(c.env.DB, parsed.data);
  return c.json({ ok: true, result });
});

app.get("/docs", async (c) => {
  const section = c.req.query("section");
  const docs = await list_docs(c.env.DB, section);
  return c.json({ docs });
});

app.get("/doc/:slug", async (c) => {
  const found = await get_doc(c.env.DB, c.req.param("slug"));
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});

app.get("/feed", async (c) => {
  const tags = c.req.query("tags");
  const limit = c.req.query("limit");
  const feed = await get_feed(c.env.DB, {
    author: c.req.query("author"),
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    since: c.req.query("since"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ feed });
});

app.get("/search", async (c) => {
  const limit = c.req.query("limit");
  const results = await search_context(c.env.DB, c.req.query("q") ?? "", {
    section: c.req.query("section"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ results });
});
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes.ts
git commit -m "feat: add Hono routes for /ingest and read endpoints"
```

---

## Task 9: MCP server (stateless createMcpHandler)

**Phase 5 — parallel with Tasks 8 + 11.**

**Files:**
- Create: `src/mcp.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`); `agents/mcp` (`createMcpHandler`); `zod`; `src/env.ts` (`Env`); `src/tools/reads.ts` + `src/tools/writes.ts`.
- Produces: `handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>`.

- [ ] **Step 1: Create `src/mcp.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";
import { append_feed, propose_doc_update } from "./tools/writes";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fresh McpServer per request — MCP SDK 1.26+ guards against reused instances,
  // so it must NOT be constructed in global scope.
  const server = new McpServer({ name: "sapling-context", version: "1.0.0" });

  server.tool("get_doc", "Get a doc and all its versions by slug.", { slug: z.string() }, async ({ slug }) =>
    asText(await get_doc(env.DB, slug))
  );

  server.tool("list_docs", "List docs, optionally filtered by section.", { section: z.string().optional() }, async ({ section }) =>
    asText(await list_docs(env.DB, section))
  );

  server.tool(
    "get_feed",
    "Read the feed with optional author/tags/since/limit filters.",
    { author: z.string().optional(), tags: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() },
    async (args) => asText(await get_feed(env.DB, args))
  );

  server.tool(
    "search_context",
    "Text search across docs, feed, and ADRs.",
    { query: z.string(), section: z.string().optional(), limit: z.number().optional() },
    async ({ query, section, limit }) => asText(await search_context(env.DB, query, { section, limit }))
  );

  server.tool(
    "append_feed",
    "Append an entry to the append-only feed (working memory).",
    { author: z.string(), summary: z.string(), body: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ author, summary, body, tags }) => asText({ id: await append_feed(env.DB, { author, summary, body, tags }) })
  );

  server.tool(
    "propose_doc_update",
    "Stage a new doc version (non-destructive; current_version is untouched).",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
      author: z.string(),
    },
    async ({ author, ...proposal }) => asText(await propose_doc_update(env.DB, proposal, author))
  );

  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0. If `createMcpHandler` is not found on `agents/mcp`, confirm `agents@^0.16.2` is installed (it exports both `createMcpHandler` and the deprecated `experimental_createMcpHandler`).

- [ ] **Step 3: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add stateless MCP server over HTTP via agents/mcp"
```

---

## Task 10: Worker entry (wire routes + MCP)

**Phase 6 — depends on Tasks 8 + 9.**

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `src/routes.ts` (`app`), `src/mcp.ts` (`handleMcp`), `src/env.ts` (`Env`).
- Produces: the default `ExportedHandler<Env>` Worker export.

- [ ] **Step 1: Create `src/index.ts`**

```ts
import { app } from "./routes";
import { handleMcp } from "./mcp";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    // Only non-asset requests reach here.
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire Worker entry — /mcp to MCP handler, rest to Hono"
```

---

## Task 11: Web placeholder (Vite build, proves the shared/ path)

**Phase 5 — parallel with Tasks 8 + 9.** Depends only on Task 1.

**Files:**
- Create: `web/index.html`, `web/src/main.ts`, `web/vite.config.ts`
- Remove: `web/dist/.gitkeep` (Vite will populate `web/dist`)

**Interfaces:**
- Consumes: `@shared/vocabulary` (`SECTIONS`) — a runtime value, to prove `web/` genuinely shares code with `shared/` through the bundler.
- Produces: a built static site in `web/dist` (the assets binding target). NOT a real UI.

- [ ] **Step 1: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: { "@shared": path.join(__dirname, "..", "shared") },
  },
});
```

- [ ] **Step 2: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sapling Context Store — smoke test</title>
  </head>
  <body>
    <h1>Sapling Context Store</h1>
    <p>Same-origin smoke test (NOT the real UI).</p>
    <pre id="out">loading…</pre>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `web/src/main.ts`**

```ts
// Placeholder smoke test of the same-origin wiring + the shared/ import path.
// Importing a runtime value from @shared proves web/ and src/ truly share shared/.
import { SECTIONS } from "@shared/vocabulary";

const out = document.getElementById("out")!;
const header = `sections (from @shared/vocabulary): ${SECTIONS.join(", ")}`;

out.textContent = `${header}\n\nfetching /feed …`;

fetch("/feed")
  .then((r) => r.json())
  .then((data) => {
    out.textContent = `${header}\n\n/feed response:\n${JSON.stringify(data, null, 2)}`;
  })
  .catch((err) => {
    out.textContent = `${header}\n\nerror fetching /feed: ${String(err)}`;
  });
```

- [ ] **Step 4: Remove the stub and build**

Run: `git rm web/dist/.gitkeep` then `npm run build:web`
Expected: Vite reports a successful build; `web/dist/index.html` and a hashed JS asset exist. Confirm with: `ls web/dist`

- [ ] **Step 5: Type-check the web project**

Run: `npx tsc -p tsconfig.web.json`
Expected: exits 0 (`document` resolves via the DOM lib; `@shared/vocabulary` resolves via the path alias).

- [ ] **Step 6: Commit**

```bash
git add web tsconfig.web.json
git commit -m "feat: add Vite web placeholder that shares shared/ and fetches /feed"
```

---

## Task 12: Integration — migrations, suite, end-to-end smoke

**Phase 7 — sequential, last. Depends on everything.**

**Files:**
- Modify (only if a wiring fix is needed): any of `src/*`, `wrangler.toml`
- Create: none (verification task)

**Interfaces:**
- Consumes: the entire build.

- [ ] **Step 1: Type-check both projects**

Run: `npm run typecheck`
Expected: both `tsc` invocations exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — 5 tests across the two files.

- [ ] **Step 3: Apply migrations locally and start the dev server**

Run: `npm run db:migrate:local` then `npm run dev`
Expected: `wrangler dev` boots and prints a local URL (typically `http://localhost:8787`). `npm run dev` builds `web/dist` first, so the assets binding has content. Leave it running for the next steps (use a second terminal).

- [ ] **Step 4: Smoke-test the static site + same-origin API**

Run:
```bash
curl -s http://localhost:8787/ | grep -i "Sapling Context Store"
curl -s http://localhost:8787/feed
```
Expected: the first returns the placeholder HTML (served by the assets binding); the second returns `{"feed":[]}` from the Worker — same origin, no CORS config.

- [ ] **Step 5: Smoke-test the ingest → read round trip**

Run:
```bash
curl -s -X POST http://localhost:8787/ingest \
  -H 'content-type: application/json' \
  -d '{"session":{"author":"andres","ended_at":"2026-06-24T00:00:00Z","skill_version":"1.0"},
       "feed_entries":[{"summary":"first entry","body":"hello","tags":["auth"],"artifacts":{"prs":[],"commits":[]}}],
       "doc_proposals":[{"slug":"architecture","section":"reference","title":"Architecture","body":"# arch","change_summary":"init","confidence":"high"}]}'
curl -s http://localhost:8787/feed
curl -s http://localhost:8787/doc/architecture
```
Expected: ingest returns `{"ok":true,"result":{"feed":1,"docs":1,"adrs":0,"triaged":0}}`; `/feed` shows the "first entry"; `/doc/architecture` shows the doc with `current_version: 0` and one staged version.

- [ ] **Step 6: Smoke-test the MCP endpoint handshake**

Run:
```bash
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```
Expected: a JSON-RPC result (not an HTML 404) containing `serverInfo` with `"name":"sapling-context"`. This confirms `/mcp` falls through to the Worker and `createMcpHandler` responds. (If it returns the static 404 / index instead, confirm `src/index.ts` routes `/mcp` before the Hono app and that no asset named `/mcp` exists.)

- [ ] **Step 7: Stop the dev server and commit any fixes**

Stop `wrangler dev`. If Steps 1-6 required wiring fixes, commit them:
```bash
git add -A
git commit -m "fix: integration wiring for end-to-end ingest, read, and MCP"
```
If no fixes were needed, note that explicitly and skip the commit.

---

## Self-Review

**Spec coverage** — every scope item maps to a task:
1. D1 schema + migration → Task 2.
2. Zod contract + row types + vocabulary in `shared/` → Task 3.
3. `POST /ingest` validates envelope, calls consumer directly (Queue seam) → Task 8 (route) + Task 7 (consumer).
4. Consumer: vocab gate, feed direct, docs staged non-destructively, ADR drafts staged, triage routing → Task 7 (+ Task 6 write tools).
5. Read functions (`get_doc`, `list_docs`, `get_feed`, `search_context`) + HTTP routes → Task 5 + Task 8.
6. MCP server wrapping reads + `append_feed` + `propose_doc_update` → Task 9.
7. Web placeholder fetching `/feed`, assets binding wired → Task 11 + Task 1 (`wrangler.toml`) + Task 10 (entry).
- Deferred items (Queue, Vectorize, auth, real UI, session-end skill) → left as documented seams, not built.
- Required tests (vocab gate, non-destructive doc write) → Task 7 and Task 6 respectively.

**Placeholder scan:** no TBD/TODO/"handle edge cases"/"similar to" — every code step contains complete code; every run step has an exact command and expected output. The `wrangler.toml` `database_id` is an intentional local placeholder with an explicit instruction to replace it before deploy (deploy is out of v1 scope).

**Type consistency:** `consume(db, payload)` returns `IngestResult` consumed by the `/ingest` route. `propose_doc_update` returns `{ slug, version, status }` asserted identically in Task 6's test and used by the MCP tool. `get_feed`'s `FeedFilter` shape matches the object built in the `/feed` route. `Env` (`DB`, `ASSETS`) is defined once in `src/env.ts` and imported by routes, mcp, and index. `DocRow`/`DocVersionRow`/`NeedsTriageRow` field names match the SQL columns in Task 2.

---

## Execution Handoff

See the offer in the chat response.
