# Canopy — complete build spec (all phases, everything needed)

The single detailed spec for the whole build: the read-side brain, the reconciler + per-target writer, the
triage write-back routes, the triage UI rework, and theming. This is the lower layer — the orchestrator
(`canopy-orchestrator.md`) dispatches one subagent per phase against the matching section here. Everything a
subagent needs to execute its phase is in that phase's section plus the global rules below.

Repo: `SaplingLearn/canopy`. Read `CLAUDE.md` first. Work locally (`wrangler dev` / `npm test`); never
deploy. Land small, reviewable commits in each phase's commit order.

---

## Through-line

Agent orients against authority-flagged context (Phase 1) → works → at session end emits one structured,
per-target payload declaring exactly what it touched and from what base (Phase 2 writer) → the worker
reconciles against the KB, drops no-ops, stages only real deltas, classifies each new/edit/rewrite (Phase 2
reconciler) → feed/focus go live, the rest land typed and flagged in Triage → a human promotes, rejects, or
places them via working routes (Phase 3) rendered by shape (Phase 4). Theming unifies the badges the loop
produces (Phase 5).

## Phase map + dependencies

- **Phase 1 — Read-side brain.** Query tool (FTS5 + bm25), authority flags, retrieval skill, Search.
  Independent.
- **Phase 2 — Contract + reconciler + per-target writer.** Write-side foundation. Uses Phase 1's `query` if
  present, else `get_doc`. Produces `authority`/`change_kind`/flags consumed by Phase 4.
- **Phase 3 — Triage write-back routes.** Resolve / assign / reject. Build after Phase 2.
- **Phase 4 — Triage UI rework.** Renders by change-type. Needs Phase 2 metadata + Phase 3 routes. Last code
  phase.
- **Phase 5 — Theming.** Palette over CSS vars + badges. After Phase 4.

```
Phase 1 ──(query tool)──┐
                         ▼
Phase 2 ──(change_kind, flags)──► Phase 4 ──► Phase 5
   └────► Phase 3 ──(routes)──────┘
```

## Locked decisions (settled — do not re-open)

Read side: FTS5 now, Vectorize a named seam; one rich `query` + `get_doc`; agent `include_staged:true`,
human Search `false`; structured search now, synthesis a commented `POST /ask` seam.

Write side: reconciliation lives in the gate so every entry point inherits it; doc dedupe is content-hash
with a `force` escape hatch; low-confidence routes to triage for a **new** slug but stages-and-flags for an
**existing** slug; triage "assign" **materializes** the real entry through the gate, then resolves.

## Invariants (every phase upholds these)

- Single gated write path: all writes funnel through `src/consumer.ts`. Adding a write means adding it to
  the gate, never a parallel surface.
- Author is always the authenticated principal; client `session.author` stays advisory and ignored.
- Non-destructive: staging never mutates live `docs.body`/`current_version`; promotion is the only mutator
  and is human-only. Reject and resolve are soft status flags, never hard-deletes.
- `shared/` is the only cross-cutting layer; contract/row/vocab changes live there.
- Test the real call path: drive registered tools and live routes, not helpers. (A prior bug shipped green
  because a test exercised a helper the live tool never imported — `append_feed` dropping prs/commits.)

---

# Phase 1 — Read-side brain

**Goal.** Replace flat `LIKE` search with a ranked, assembled query tool that returns whole authoritative
bodies plus ranked pointers, each authority-flagged, and give the agent the capacity (the tool) and the
knowledge (a model-invocable retrieval skill + a CLAUDE.md note) to orient on its own. Back the human Search
screen with the same tool.

## 1.1 FTS5 tables + triggers (`migrations/0008_fts.sql`)

Standalone (not external-content) FTS5 virtual tables mirroring searchable text of `docs`, `feed`, `adrs`,
each carrying its base key as `UNINDEXED`. Standalone chosen to sidestep the TEXT-slug-vs-integer-rowid
mismatch on `docs` and to keep the test harness's truncation working.

```sql
CREATE VIRTUAL TABLE docs_fts USING fts5(
  slug UNINDEXED, title, section UNINDEXED, body, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE feed_fts USING fts5(
  feed_id UNINDEXED, summary, body, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE adrs_fts USING fts5(
  adr_id UNINDEXED, title, context, decision, rationale, tokenize = 'porter unicode61');
```

Triggers cover every path that changes searchable text:
- `docs`: AFTER INSERT, AFTER DELETE, AFTER UPDATE OF title/section/body. `docs.body` changes on **promote**
  (`promote_doc`), so the body-update trigger is what makes a promoted doc newly searchable. Re-index by
  delete-then-insert into `docs_fts` keyed on `slug`.
- `feed`: AFTER INSERT, AFTER DELETE (append-only).
- `adrs`: AFTER INSERT, AFTER DELETE (status flips don't change text).

Backfill existing rows at the end (INSERT … SELECT). **Comment in the migration:** D1 cannot
`wrangler d1 export` a database containing virtual tables — drop FTS tables, export, recreate is the
documented workaround.

## 1.2 Query contract (`shared/contract.ts`)

```ts
export const QueryRequest = z.object({
  q: z.string().default(""),
  types: z.array(z.enum(["doc","decision","feed"])).optional(),  // default all
  section: z.string().optional(),
  space: z.enum(["sapling","canopy"]).optional(),
  include_staged: z.boolean().optional(),     // caller sets default (see 1.4)
  limit: z.number().optional(),               // full-body primary count (default 6)
  pointer_limit: z.number().optional(),       // ranked snippet count (default 20)
});

export const Authority = z.enum(["live","staged_pending","unpromoted","draft"]);

export const QueryPrimary = z.object({
  type: z.enum(["doc","decision","feed"]), id: z.string(), title: z.string(),
  section: z.string().nullable(), space: z.string().nullable(),
  body: z.string(),                           // FULL current authoritative body
  authority: Authority,
  current_version: z.number().nullable(), pending_version: z.number().nullable(),
  staged_body: z.string().nullable(),         // only when include_staged and a pending version exists
  confidence: z.string().nullable(),
  updated_at: z.string().nullable(), updated_by: z.string().nullable(),
  score: z.number(),                          // normalized so higher = better
});

export const QueryPointer = z.object({
  type: z.enum(["doc","decision","feed"]), id: z.string(), title: z.string(),
  snippet: z.string(), authority: Authority, score: z.number(),
});

export const QueryResult = z.object({
  primary: z.array(QueryPrimary), pointers: z.array(QueryPointer),
  meta: z.object({ engine: z.literal("fts5"), total: z.number() }),
});
```

## 1.3 Engine (`src/tools/reads.ts`, new `query()`)

- bm25-ranked FTS5 per requested type, weighting title/section above body (docs), title above the rest
  (adrs), summary above body (feed) via `bm25(table, w0, w1, …)`. Normalize raw bm25 (ascending-better) to
  `score` (higher better). **Comment: RRF (Reciprocal Rank Fusion) is the future cross-source merge when
  Vectorize lands** — the contract here is the stable seam.
- Global top-`limit` by score → `primary`, hydrated from base rows with FULL body + authority. Remainder up
  to `pointer_limit` → `pointers` with fts5 `snippet()`.
- **Authority:** doc `current_version===0` → `unpromoted`; else a `doc_versions` row `status='staged'` with
  `version > current_version` → `staged_pending` (set `pending_version`, and `staged_body` only when
  `include_staged`); else `live`. adr `ratified` → `live`, else `draft`. feed always `live`.
- `include_staged` true: return staged/unpromoted content and reach staged bodies. False: null `staged_body`
  and drop `unpromoted` (empty-body) docs from `primary`.
- Empty `q`: degrade to filtered browse (section/space/type), ordered by `updated_at` desc.

Keep `get_doc` for exact-slug fetch. Do not leave a second divergent search engine — route or remove
`search_context`.

## 1.4 Wiring

- **MCP (`src/mcp.ts`):** register `query`, agent default `include_staged:true`. Description (load-bearing
  for proactivity): "Retrieve assembled context from the team brain… each result flagged live /
  staged_pending / unpromoted / draft — treat anything not live as not-yet-settled. Use to orient before
  working an existing area and ALWAYS before proposing a doc change. Read-only, safe to call freely."
- **HTTP (`src/routes.ts`):** `GET /search` backs onto `query`, `include_staged` default **false**; accepts
  `q`, `types` (csv), `section`, `space`, `limit`; returns `{ result: QueryResult }`. Leave a commented seam:
  `// SEAM: POST /ask — retrieve via query(), synthesize a grounded, slug-citing answer. Out of scope.`

## 1.5 Proactive skill (`.claude/skills/load-context/SKILL.md`)

Model-invocable (do NOT set `disable-model-invocation`). The `description` is the trigger spec: fire when
starting work on a named/existing subsystem, picking up an issue referencing an area, when the user
references "the X system" / "how we do Y", and ALWAYS before proposing a doc change. Do NOT fire on trivial
questions or brand-new areas. `allowed-tools`: `mcp__canopy__query`, `mcp__canopy__get_doc`. Procedure:
focused query → read `primary` bodies → respect authority flags (never treat `staged_pending`/`draft` as
settled) → if about to write, note `current_version` for the writer's base. Never writes.

## 1.6 Knowledge layer (`CLAUDE.md`, augment)

Add a short section: Canopy is the team's working memory; orient against it before touching an existing area
(`load-context`); record what changed at session end (`record-session`); trust `live`, scrutinize
`staged_pending`/`draft`. Keep existing content intact.

## 1.7 Search screen (`web/src/api.ts`, `render.ts`, `main.ts`)

`api.ts` `search()` returns the `QueryResult` shape (re-declare the envelope; `web/` can't import `src/`).
`render.ts` renders grouped by type with authority badges (LIVE/PENDING/DRAFT), primary first then lighter
pointers; click a doc → `loadDoc(slug)`. Reuse the `Loadable<T>` pattern and Triage badge styling. Human
default stays live-only.

## 1.8 Tests + acceptance

`test/query.fts.test.ts` + a route test: sync triggers (insert/promote/delete reflect/clear); ranking
(title term outranks body term); bundle shape (primary full bodies, pointers snippets, counts honored);
authority (unpromoted / staged_pending+pending_version / ratified vs draft); `include_staged` agent-vs-human
behavior; empty-`q` browse. **Drive the registered MCP tool and the live `/search` route**, not just the
function. **Harness note:** the FTS delete-triggers must keep `*_fts` clean across `apply-migrations.ts`'s
`beforeEach` base-table truncation — assert no leaked rows; if your trigger shape doesn't cascade, add the
three `*_fts` to the truncation statement instead.

**Acceptance:** one engine; assembled bodies + ranked pointers + correct flags; MCP surfaces staged,
`/search` doesn't; FTS tables create cleanly (FTS5 compiled); write side byte-for-byte unchanged.
**Commit order:** migration+isolation proof → contract → engine+tests → MCP+route+test → skill+CLAUDE.md →
Search rewire.

---

# Phase 2 — Contract, reconciler, per-target writer

**Goal.** The worker stops being a write-through: it reconciles a structured, session-scoped payload against
the KB — replay-safe, no-op-dropping, delta-staging, change-typing — and the session-end skill becomes a
per-target writer that produces that payload, closing the ADR and prs/commits gaps.

## 2.1 Schema (`migrations/0009_reconcile.sql`)

```sql
CREATE TABLE processed_items (
  session_id TEXT NOT NULL, item_index INTEGER NOT NULL, item_type TEXT NOT NULL,
  outcome TEXT NOT NULL, ref TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, item_index));

ALTER TABLE doc_versions ADD COLUMN content_hash   TEXT;
ALTER TABLE doc_versions ADD COLUMN base_version   INTEGER;
ALTER TABLE doc_versions ADD COLUMN change_kind    TEXT;     -- new | edit | rewrite
ALTER TABLE doc_versions ADD COLUMN low_confidence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adrs                ADD COLUMN content_hash TEXT;
ALTER TABLE milestone_proposals ADD COLUMN content_hash TEXT;
CREATE INDEX idx_doc_versions_hash ON doc_versions(slug, content_hash);
CREATE INDEX idx_adrs_hash         ON adrs(content_hash);
CREATE INDEX idx_mileprop_hash     ON milestone_proposals(content_hash);
```

New TEXT status values (no migration): `doc_versions.status` += `rejected`; `adrs.status` += `rejected`
(used by Phase 3). Document in `shared/rows.ts`.

## 2.2 Contract (`shared/contract.ts`)

`Session` += `id: z.string()` (skill mints a uuid). `DocProposal` += `space: z.enum(["sapling","canopy"]).optional()`
(server defaults canopy), `base_version: z.number().optional()`, `force: z.boolean().optional()`.
`FeedEntry.artifacts` already carries prs/commits/issues — no change; the fix is making writers fill it.
`AdrDraft` already exists and `consume()` already handles `adr_drafts` — the gap is nothing emits them.

## 2.3 Reconciler (`src/consumer.ts` — extend the gate functions, do not fork)

Per item, ordered: **ledger first** — `(session.id, item_index)` already in `processed_items` → drop, return
recorded outcome (worker assigns `item_index` by stable enumeration across the payload's typed arrays).

**Doc:**

| Condition | Outcome |
|---|---|
| out-of-vocab section | triage |
| low confidence AND slug new | triage |
| low confidence AND slug exists | stage, `low_confidence=1` |
| slug new | stage v1, `change_kind='new'`, `space` set (default canopy) |
| slug exists, body hash == promoted hash OR == latest staged hash, not `force` | drop, `unchanged` |
| slug exists, body differs (or `force`) | stage new version; record `content_hash`, `base_version`; `change_kind` edit/rewrite |

`change_kind`: `new` if no promoted body; else line-diff vs current promoted body,
`changed/max(old,new) < 0.5` → `edit`, else `rewrite` (compute server-side; `render.ts:lineDiff` is a
reference). `space` (audit F4): `propose_doc_update` must persist it on doc INSERT.

**ADR:** low confidence → triage; else content-hash dedupe on `title+context+decision+rationale` → identical
exists → drop `unchanged`; else stage `draft` with `content_hash`.
**Milestone:** `done` → triage; low confidence → triage; else identity by title/`github_ref` present → drop
`unchanged`; else stage with `content_hash`.
**Feed:** out-of-vocab tag → triage; else append. No content dedupe (repeats legal); the ledger is the only
replay guard — which is exactly why feed needs it.
**Focus:** upsert, unchanged.

`consume()` returns per-type, per-outcome counts (`{docs:{staged,unchanged,triaged},…}`), surfaced on
`/ingest` so a re-run reads "3 docs: 1 staged, 2 unchanged".

## 2.4 MCP write-tool alignment (`src/mcp.ts`, `src/mcp-args.ts`)

Widen `append_feed`'s Zod schema to accept `prs`/`commits` and route through the existing
`feedEntryFromMcpArgs` helper (audit F3 — helper+test exist, live tool never imported them). Fix the test to
drive the **registered tool**. Each MCP write tool builds a one-item payload with an ephemeral `session.id`
and calls the same reconciling gate — no second path.

## 2.5 Per-target writer (`.claude/skills/record-session/SKILL.md` — evolve)

Keep explicit-only (never auto-fire). Replace feed-first single-shot with per-target feeders: (1) inventory +
classify via vocab; (2) read-before-write via `query`/`get_doc`, capture `current_version` → `base_version`,
ground confidence honestly; (3) one feeder block per type emitting its contract object — Doc
{slug,section,space,title?,body,change_summary,confidence,base_version}, ADR
{title,context,decision,rationale,confidence} (closes F5), Feed one per shipped unit with full
`artifacts:{prs,commits,issues}` observed from git/gh, Milestone only if genuinely new, Focus
{working_on,next_up?}; (4) assemble one `IngestPayload` with a minted `session.id`, **POST once to
`/ingest`**, report the structured counts. Never promote/ratify/complete.

## 2.6 Tests + acceptance

`consumer.reconcile.test.ts`: replay (same session.id+index → all-`unchanged`); doc no-op drop; edit vs
rewrite; low-conf existing→staged+flagged, new→triaged; `space` persisted; ADR/milestone dedupe; feed ledger
replay-guard but distinct repeats allowed. `mcp.append_feed.test.ts`: drive registered tool, prs/commits
round-trip. **Acceptance:** identical re-run → zero new versions, all-`unchanged`; a changed doc → exactly one
version, edit/rewrite tagged, `base_version` recorded; ADRs + prs/commits reach the store; gate still the only
path; staging still non-destructive. **Commit order:** schema → contract → reconciler+tests → MCP align+test
→ writer SKILL.md.

---

# Phase 3 — Triage write-back routes

**Goal.** Make the desk actionable: resolve, assign-materialize, reject. Wire the three inert UI handlers.
No redesign here (Phase 4) — just real routes.

## 3.1 Schema (`migrations/0010_triage_resolve.sql`)

```sql
ALTER TABLE needs_triage ADD COLUMN resolved_at  TEXT;
ALTER TABLE needs_triage ADD COLUMN resolved_by  TEXT;
ALTER TABLE needs_triage ADD COLUMN resolution   TEXT;  -- assigned | discarded
ALTER TABLE needs_triage ADD COLUMN assigned_ref TEXT;
```

## 3.2 Writers (`src/tools/writes.ts`)

`reject_doc_version(slug,version)` → `status='rejected'` if `staged`. `reject_adr(id)` → `status='rejected'`
if `draft`. `resolve_triage(id,by,resolution='discarded')` → set resolved + audit cols. `assign_triage(id,by,target)`
→ **materialize**: parse `raw`, call the **same gate path** for the target type (vocab-checked + reconciled),
then `resolve_triage(...,'assigned', assigned_ref=<what it became>)`. Assign reuses the gate; never
hand-inserts.

## 3.3 Routes (`src/routes.ts`, session-gated)

`POST /doc/:slug/reject {version}`; `POST /adr/:id/reject`; `POST /needs-triage/:id/discard`;
`POST /needs-triage/:id/assign {type,section?,space?,tags?,…}`; `GET /proposals` → staged `doc_versions`
newer than `current_version`, not rejected, joined to their doc, carrying
`change_kind`/`low_confidence`/`base_version`/both bodies (kills the web N+1, audit G9; Phase 4 needs it).
Ensure proposal/decision reads exclude `rejected`.

## 3.4 Web wiring (`web/src/api.ts`, `web/src/main.ts`)

Add `rejectDoc`/`rejectAdr`/`discardTriage`/`assignTriage`. Replace the three inert handlers (`dismiss`,
`assignItem`, `discardItem` — currently `return; // inert`) following the `promote`/`ratify` pattern
(Unauthorized→re-auth, ApiError→flash, success→reload). Repoint `listStagedProposals` to `/proposals`.

## 3.5 Tests + acceptance

Real-endpoint tests: reject flips status and leaves queue; discard resolves and drops from `/needs-triage`;
assign materializes a real row through the gate AND resolves with `assigned_ref`; double-reject/assign safe.
**Acceptance:** every queue can accept and reject/place; nothing hard-deletes; the guide's promised Dismiss is
no longer a no-op. **Commit order:** schema → writers → routes (incl `/proposals`)+tests → web wiring.

---

# Phase 4 — Triage UI rework

**Goal.** Render matched to the change: new pages preview, edits show tight diffs, rewrites go side-by-side;
authority/stale-base/low-confidence flags surface; reject sits beside promote.

## 4.1 Rendering (`web/src/render.ts`)

Branch the proposal detail (currently `lineDiff(promotedBody, stagedBody)` for everything — all-green wall on
new docs, whole-paragraph del+add on small edits, raw markdown not the page) on `change_kind`:
- `new` → markdown **preview** of the staged body (reuse `web/src/markdown.ts`), labeled "New page".
- `edit` → line diff with unchanged runs **collapsed to context** (a few lines around each hunk).
- `rewrite` → **side-by-side** rendered previews (live vs staged).
- List pane: NEW/EDIT/REWRITE chip so the queue is triageable by shape before opening; keep the confidence
  badge.
- Detail header flags: `low_confidence` → amber flag; stale base (`base_version < current_version`) → conflict
  banner "edited from v{base}; live is now v{current}".
- Actions: **Reject** beside Promote (proposals) and Ratify (decisions), wired to Phase 3; for `needs_triage`,
  real Assign-to (pick type/section) and Discard.

## 4.2 Tests + acceptance

Render tests per `change_kind` (new→preview no green-wall; edit→collapsed context; rewrite→two panes); flag
rendering; buttons emit correct `data-act`. **Acceptance:** a new 300-line doc reviews as a readable page, a
typo fix as a one-line diff, a rewrite as two panes; every item has a reject/place path; manual pass through
all three queues. **Commit order:** `/proposals` consumption + list chips → per-kind detail → flags → action
wiring.

---

# Phase 5 — Theming (Sapling palette)

**Goal.** Apply the Sapling palette across CSS vars and the status/authority/change-kind badges the loop
produces, so the desk reads as one system. Pure visual; zero behavior change.

Map the hex set onto existing tokens in `web/src/canopy.css`:
- Surfaces/ink: `--bg`←`#faf8f3`, sidebar `#f4f1ea`, hovers `#ebe6dc`; `--fg`←`#1a1814`, muted `#8a8372`/
  `#3f3b31`; panel `#fdfcf9`; hairline border `rgba(42,39,31,0.10)`.
- Brand/accent: `--brand`←forest `#1B6C42`; `--accent`←sage `#8a9a5b`, accent-fg `#ffffff`; Sap green scale
  for hovers/fills.
- Status + badges: `--amber` `#b4562c` (low-confidence/staged), `--red` `#a83a3a` (needs-triage/reject),
  `--blue` `#3e6f8a` (draft), `--green` `#1B6C42` / mastery `#4a7d5c` (live/promote). Map authority +
  change-kind chips (LIVE/PENDING/DRAFT/NEW/EDIT/REWRITE/LOW-CONF) onto these consistently across Docs,
  Triage, Search.
- Dark theme derives from the same tokens; keep `resolvedTheme()`.

**Acceptance:** one token source, no hardcoded hex in renderers, badges consistent everywhere, both themes
legible.

---

## Definition of done (whole build)

Agent orients via `query`/`load-context` on authority-flagged context → works → ends with a per-target batch
write → worker reconciles (replay-safe, no-op-dropping, delta-staging, change-typed) → feed/focus live, rest
staged typed+flagged → human promotes/rejects/places in a desk that renders by shape with working exits →
promotion updates the live doc and the FTS index re-syncs so next read + search reflect it. Every phase green
on `npm test` + `npm run typecheck`; write side still single-gated and non-destructive.

## Out of scope

Semantic retrieval (Vectorize) — named seam only. LLM synthesis (`POST /ask`) — commented seam only. Auth,
roadmap GitHub-progress, dashboard internals — untouched. No hard-deletes anywhere.
