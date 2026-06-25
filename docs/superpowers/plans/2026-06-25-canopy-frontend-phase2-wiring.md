# Canopy Frontend Phase 2 — Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, review between tasks). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase-1 hardcoded mock data in `web/src/` with real fetches against the Worker routes, rendering real `@shared` row shapes, one screen at a time, without altering the Phase-1 look. **Scope expansion (user-approved):** add four missing read routes + one callback redirect to `src/` so Triage and Settings can wire fully.

**Architecture:** Add a typed fetch layer (`web/src/api.ts`) over the routes; convert the synchronous mock render into an async load-then-render loop in `main.ts`. `render.ts` keeps its locked markup but consumes real shapes. New backend read routes are TDD'd against real Miniflare D1. Local verification runs against `wrangler dev` with a seeded D1 + a forged session cookie (real OAuth can't run locally).

**Tech Stack:** Vanilla TS + Vite, Cloudflare Worker + Hono + D1, `@shared` (`rows.ts` row shapes, `contract.ts` ingest contract, `vocabulary.ts` sections/tags). Tests: vitest + `@cloudflare/vitest-pool-workers` (real Miniflare D1). Verification: `wrangler d1 execute --local`, `curl`, headless Chromium.

## Global Constraints

- **`src/` changes are APPROVED ONLY for the five additions in Phase 2a** (GET `/auth/me`, `/needs-triage`, `/adrs`, `/milestone-proposals`, and the `/auth/callback` non-member redirect). **Every other `src/` route stays untouched.** Do not redefine contract types. Do not deploy or push.
- Do **NOT** alter the Phase-1 appearance. Wiring only. If real data overflows/breaks a layout, **STOP and report** — do not redesign.
- **Kill duplicate types:** as each screen is wired, delete that screen's mock types from `web/src/data.ts` and import the real shapes from `@shared/rows` / `@shared/contract`. Tags/sections come from `@shared/vocabulary` — no hardcoded vocab in the UI. End state: a contract change BREAKS `npm run typecheck`.
- **Confirm/read actions are cookie-authed** (`credentials:"same-origin"`). The MCP bearer is for `/mcp` only and must never appear in the UI.
- Any remaining element with no backing route (the un-approved gaps below) STOPs and reports — never a surviving mock.
- `npm run typecheck` clean; `npm test` green (incl. new route tests); ASSETS still `web/dist`; one origin intact.

---

## Investigation findings — REAL shapes (code wins over the prompt)

All routes are session-cookie-gated except `/auth/login`, `/auth/callback`. `src/routes.ts` + `src/auth/routes.ts`.

| Route | Returns | `@shared/rows` type |
|---|---|---|
| `GET /feed?author=&tags=&since=&limit=` | `{ feed: FeedRow[] }` | `FeedRow{id,author,summary,body\|null,artifacts:string\|null(JSON),created_at}` |
| `GET /docs?section=` | `{ docs: DocRow[] }` | `DocRow{slug,section,title,body,current_version,updated_at\|null,updated_by\|null}` |
| `GET /doc/:slug` | `{ doc:DocRow, versions:DocVersionRow[] }` or `404` | `DocVersionRow{id,slug,version,body,summary\|null,status:"staged"\|"promoted",confidence\|null,created_at,created_by}` |
| `GET /search?q=&section=&limit=` | `{ results: SearchResult[] }` | `SearchResult{type:"doc"\|"feed"\|"adr",id,title,snippet}` (in `src/tools/reads.ts`, NOT `@shared`) |
| `GET /roadmap` | `{ milestones:(MilestoneRow&{progress:{closed,total}\|null})[] }` | `MilestoneRow{id,title,description\|null,target_date,status:"upcoming"\|"in_progress"\|"done",github_ref\|null,created_at,created_by,updated_at\|null}` |
| `POST /doc/:slug/promote` `{version}` | `{ok,slug,version,status:"promoted"}` / 400 | — |
| `POST /adr/:id/ratify` | `{ok,id,status:"ratified"}` / 400 | — |
| `POST /milestone-proposals/:id/promote` | `{ok,milestone:MilestoneRow}` / 400 | — |
| `POST /milestones/:id/complete` | `{ok,milestone:MilestoneRow}` / 400 | — |
| `POST /auth/logout` | `{ok:true}` | — |
| `POST /auth/mcp-token` | `{token:<raw>}` (one-time) | — |

**Vocabulary (real):** `SECTIONS=[reference,context,decisions,needs-triage]`, `TAGS=[auth,architecture,infra,api,ui,data]`. Rebuild filters from these.

**Test harness:** `app.request(path, init, env)`; `authedCookie(login)` = insert `users` row + `createSession(env.DB, login)` + `session=${hmacSeal(id, "test-cookie-secret")}`. Tools tested directly. Pattern: `test/doc-promote-adr-ratify.test.ts`.

### Code-vs-prompt disagreements (code wins — report these)
1. Feed *read* returns `FeedRow` (no tags; `artifacts` a JSON string), **not** the write-contract `FeedEntry`. Read screens use `rows.ts`, not `contract.ts`.
2. Route *response* types (`SearchResult`, the `{feed}`/`{docs}`/`{results}`/`{milestones}` envelopes, `progress`) live in `src/tools/*`, not `@shared`; `web/` can't import `src/`. `api.ts` re-declares these thin types atop the `@shared` rows it can import.

### GAP STATUS (after scope expansion)
- **RESOLVED by Phase 2a:** G6 ADR-draft list → `GET /adrs?status=draft` (B3); G7 needs_triage list → `GET /needs-triage` (B2); G8 milestone-proposal list → `GET /milestone-proposals` (B4); G10 identity/profile → `GET /auth/me` (B1); G12 non-member screen → `/auth/callback` redirect `/?denied=1` (B5).
- **G9 Proposals queue (staged doc versions):** still no single route — built via `GET /docs` + `GET /doc/:slug` per doc (N+1 workaround; report). *(Not in the approved four.)*
- **STILL CUT + REPORT (not approved, no route):** G1 feed-entry tags; G2 search section/author/tags; G3 search adr-result navigation (no adr detail route); G4 roadmap per-issue chips; G5 roadmap narrative tab; G11 doc-tree DRAFT/RATIFIED badge dots; needs_triage **assign/discard** writes (no route — buttons inert); MCP-token **list + revoke** (no route — list shows only freshly minted, revoke inert).
- **Minor:** authors are `github_login` only → initials derived, names shown as logins, relative time from `created_at`.

---

## File Structure
- **Create** `web/src/api.ts` — typed fetch layer (only place that knows URLs/shapes).
- **Create** `scripts/seed-dev.sql`, `scripts/dev-cookie.mjs`, `scripts/dev-shot.mjs` — local seed + forged cookie + screenshot helper (verification only).
- **Modify** `src/tools/reads.ts` (B2–B4 tools), `src/routes.ts` (B2–B4 routes), `src/auth/routes.ts` (B1 `/me`, B5 redirect).
- **Modify** `web/src/main.ts` (async load + real dispatch), `web/src/render.ts` (real shapes; vocab filters; loading/empty), shrink/delete `web/src/data.ts`.
- **Create** `test/auth-me.test.ts`, `test/triage-reads.test.ts` (B1–B4); amend `test/auth-routes.test.ts` if it asserts the old 403 (B5).

---

## Task 0: Local dev + verification harness (blocks all verification)

**Files:** Create `scripts/seed-dev.sql`, `scripts/dev-cookie.mjs`, `scripts/dev-shot.mjs`.
**Produces:** seeded local D1 + `node scripts/dev-cookie.mjs` → `session=devsession.<sig>`, reused by every task's verification.

- [ ] **Step 1: Seed SQL** (`scripts/seed-dev.sql`) — real vocab only; clears data tables then inserts: `users(devuser)`; `sessions(id='devsession', expires far future)`; ≥3 docs across `reference|context|decisions` with promoted + one newer **staged** version; feed rows + `entry_tags`; ≥2 `adrs` (one `draft`, one `ratified`); ≥2 `needs_triage`; ≥3 `milestones` (done/in_progress/upcoming, with+without `github_ref`); ≥1 `milestone_proposals` (`staged_status='staged'`). (See seed body in the prior plan revision / mirror the Phase-1 mock content but with real vocab tags `ui,architecture,auth,data`.)
- [ ] **Step 2: Cookie forger** (`scripts/dev-cookie.mjs`) — read `COOKIE_SECRET` from `.dev.vars`, `HMAC-SHA256`-seal the session id as `${id}.${base64url(sig)}` (exactly `src/auth/crypto.ts:hmacSeal`), print `session=<sealed>`.
- [ ] **Step 3: Seed + prove the gate opens.**
```bash
npx wrangler d1 migrations apply canopy --local
npx wrangler d1 execute canopy --local --file=scripts/seed-dev.sql
# shell B: npm run dev   (http://localhost:8787)
COOKIE=$(node scripts/dev-cookie.mjs)
curl -s -o /dev/null -w "no-cookie /feed -> %{http_code}\n" http://localhost:8787/feed          # 401
curl -s -H "Cookie: $COOKIE" http://localhost:8787/feed | head -c 200                            # {"feed":[...]}
```
- [ ] **Step 4: `scripts/dev-shot.mjs`** — launch Playwright-cache Chromium with `--remote-debugging-port`, CDP `Network.setCookie({name:"session",value:"<id>.<sig>",url:"http://localhost:8787"})`, navigate, screenshot. Verification only.
- [ ] **Step 5: Commit** `chore(web): Phase-2 dev harness — seed D1 + forge session cookie`.

---

## Phase 2a — Backend read routes (TDD; `src/` changes APPROVED for these only)

> Each: tool fn in `src/tools/reads.ts` (unit-tested) + thin gated handler + HTTP test (authed 200 + unauth 401), matching `test/doc-promote-adr-ratify.test.ts`. Test secret `"test-cookie-secret"`.

### Task B1: `GET /auth/me` → `{login,name,org}` (resolves G10)
**Files:** Modify `src/auth/routes.ts`; Test `test/auth-me.test.ts`.
- [ ] Step 1: failing test — authed `GET /auth/me` → 200 `{login:"andres",name:"andres",org:"SaplingLearn"}`; no cookie → 401.
- [ ] Step 2: implement in `authApp` (gated by the parent gate):
```ts
import { first } from "../db";
import { SAPLING_ORG } from "./github";
authApp.get("/me", async (c) => {
  const login = c.get("principal").login;
  const row = await first<{ name: string | null }>(c.env.DB, `SELECT name FROM users WHERE github_login = ?`, login);
  return c.json({ login, name: row?.name ?? null, org: SAPLING_ORG });
});
```
- [ ] Step 3: green. Step 4: commit `feat(api): GET /auth/me (principal + name + org)`.

### Task B2: `GET /needs-triage` (resolves G7)
**Files:** `src/tools/reads.ts` (`list_needs_triage`), `src/routes.ts`, Test `test/triage-reads.test.ts`.
```ts
// reads.ts
import type { NeedsTriageRow } from "@shared/rows";
export async function list_needs_triage(db: DB): Promise<NeedsTriageRow[]> {
  return all<NeedsTriageRow>(db, `SELECT * FROM needs_triage WHERE resolved = 0 ORDER BY created_at DESC, id DESC`);
}
// routes.ts
app.get("/needs-triage", async (c) => c.json({ items: await list_needs_triage(c.env.DB) }));
```
- [ ] TDD: seed via `route_triage` (from `src/tools/writes`), assert tool returns unresolved only; HTTP authed 200 `{items:[...]}`, unauth 401. Commit `feat(api): GET /needs-triage`.

### Task B3: `GET /adrs?status=` (resolves G6)
```ts
import type { AdrRow } from "@shared/rows";
export async function list_adrs(db: DB, status?: string): Promise<AdrRow[]> {
  return status
    ? all<AdrRow>(db, `SELECT * FROM adrs WHERE status = ? ORDER BY created_at DESC, id DESC`, status)
    : all<AdrRow>(db, `SELECT * FROM adrs ORDER BY created_at DESC, id DESC`);
}
// routes.ts
app.get("/adrs", async (c) => c.json({ adrs: await list_adrs(c.env.DB, c.req.query("status")) }));
```
- [ ] TDD: seed via `stage_adr` + ratify one; assert `?status=draft` filters to the draft; HTTP authed/unauth. Commit `feat(api): GET /adrs`.

### Task B4: `GET /milestone-proposals` (resolves G8)
```ts
import type { MilestoneProposalRow } from "@shared/rows";
export async function list_milestone_proposals(db: DB): Promise<MilestoneProposalRow[]> {
  return all<MilestoneProposalRow>(db, `SELECT * FROM milestone_proposals WHERE staged_status = 'staged' ORDER BY created_at DESC, id DESC`);
}
// routes.ts
app.get("/milestone-proposals", async (c) => c.json({ proposals: await list_milestone_proposals(c.env.DB) }));
```
- [ ] TDD: seed via `stage_milestone_proposal`; promote one and assert it drops out (staged-only); HTTP authed/unauth. Commit `feat(api): GET /milestone-proposals`.

### Task B5: non-member callback redirect (resolves G12)
**Files:** `src/auth/routes.ts`; verify/amend `test/auth-routes.test.ts`.
- [ ] Step 1: read `test/auth-routes.test.ts`; if it asserts the `403 {error:"forbidden"}`, update it for the redirect.
- [ ] Step 2: change the forbidden branch in `/auth/callback`:
```ts
// was: if (!(await isActiveOrgMember(token))) return c.json({ error: "forbidden" }, 403);
if (!(await isActiveOrgMember(token))) return c.redirect("/?denied=1", 302);
```
- [ ] Step 3: test — stub `isActiveOrgMember` false → callback 302 `Location: /?denied=1`, **no** session row created. Green; `npm test` fully green. Commit `feat(auth): non-member callback redirects to /?denied=1`.

**After Phase 2a:** `npm test` green, `npm run typecheck` clean. These routes are consumed by Tasks 5 & 6.

---

## Task 1: FEED → `GET /feed`
**Files:** `web/src/api.ts` (+`getFeed`), `main.ts` (async load), `render.ts` (`feedView`←`FeedRow`), `data.ts` (delete `feed`,`FeedEntry`,`Artifact`).
- [ ] Step 1: `api.ts` with `getJson`/`postJson` (`credentials:"same-origin"`; 401→`Unauthorized`) + `getFeed(q?)` building `?author=&tags=`.
- [ ] Step 2: `main.ts` per-screen `data` + `status:"loading"|"ok"|"error"|"unauth"`; on Feed entry + filter change → `getFeed` → re-render; `Unauthorized`→`view:"auth"`. Map `FeedRow`→view: author=login, initials=first 2 letters upper, name=login, time=relative(created_at), body=`body??""`, artifacts=`JSON.parse(artifacts??"{}")` → prs→PR/commits→commit/issues→issue. **No per-entry tags (G1).**
- [ ] Step 3: header tag filter from `@shared/vocabulary.TAGS`; author filter from distinct authors in loaded feed.
- [ ] Step 4: empty ("No entries…"), minimal loading (no look change), inline error.
- [ ] Step 5: delete feed mocks; typecheck.
- [ ] Step 6: verify — `curl -H "Cookie:$COOKIE" /feed`; `dev-shot feed`; typecheck clean. Commit `feat(web): wire Feed to GET /feed`.

## Task 2: DOCS → `GET /docs` + `GET /doc/:slug`
**Files:** `api.ts` (`listDocs`,`getDoc`), `main.ts`, `render.ts` (`docsView`), `data.ts` (delete doc mocks/types).
- [ ] Step 1: `listDocs():Promise<DocRow[]>`; `getDoc(slug):Promise<{doc,versions}>` (404→typed `NotFound`).
- [ ] Step 2: tree from `DocRow[]` grouped by `section` (reference→context→decisions; uppercase header). **No badge dots (G11).**
- [ ] Step 3: reader from `{doc,versions}` — title/section/body from `doc`; updatedBy=`doc.updated_by`; staged banner iff `versions.some(v=>v.status==="staged"&&v.version>doc.current_version)`; version history from `versions` (label`v{n}`, note=`summary`, who=`created_by`, current=`version===current_version`).
- [ ] Step 4: 404 → muted "Doc not found."
- [ ] Step 5: delete doc mocks; typecheck.
- [ ] Step 6: verify `/doc/<seeded>` (staged version present), `/doc/nope`→404, shot. Commit `feat(web): wire Docs`.

## Task 3: SEARCH → `GET /search`
**Files:** `api.ts` (`search`), `main.ts` (debounced), `render.ts` (`searchView`), `data.ts` (delete search mocks).
- [ ] Step 1: `search(q,section?)`; re-declare `SearchResult` in `api.ts`.
- [ ] Step 2: input→debounced fetch; type chips map Decisions→`adr`, filter client-side by `type`; card = type badge + title + snippet (client highlight). **Cut section/author/tags (G2).**
- [ ] Step 3: nav: doc→open by slug, feed→go Feed, **adr→inert (G3)**.
- [ ] Step 4: no-results state; loading.
- [ ] Step 5: delete mocks; typecheck.
- [ ] Step 6: verify `/search?q=…`, shot. Commit `feat(web): wire Search`.

## Task 4: ROADMAP → `GET /roadmap`
**Files:** `api.ts` (`getRoadmap`), `main.ts`, `render.ts` (`roadmapTimeline`), `data.ts` (delete roadmap mocks; `TODAY_ISO`→real `Date.now()`).
- [ ] Step 1: `getRoadmap()`; re-declare `MilestoneWithProgress` atop `MilestoneRow`.
- [ ] Step 2: timeline — title/about(`description`)/date(`target_date`)/status badge; progress bar from `progress{closed,total}` when non-null, **graceful empty when null (local default — never an error)**; overdue/next from `target_date`+`status`+real now; ready only when `progress&&closed===total`. **Cut issue chips (G4).**
- [ ] Step 3: **cut Narrative tab (G5)** — Timeline only (report).
- [ ] Step 4: delete mocks; typecheck.
- [ ] Step 5: verify `/roadmap` (progress null locally renders cleanly), shot. Commit `feat(web): wire Roadmap (null-progress graceful)`.

## Task 5: TRIAGE → real reads (B2–B4) + cookie-authed confirms
**Files:** `api.ts` (`listAdrs`,`listNeedsTriage`,`listMilestoneProposals`,`promoteDoc`,`ratifyAdr`,`promoteMilestoneProposal`,`completeMilestone`), `main.ts`, `render.ts`, `data.ts` (delete triage mocks).
- [ ] Step 1: add the four read fns + four confirm POSTs (cookie-authed; 401/403 distinct from 400).
- [ ] Step 2: **Proposals queue (G9 workaround)** — `listDocs()`+`getDoc()` per doc, collect `status==="staged"&&version>current_version`; detail shows staged vs promoted body; Promote → `promoteDoc(slug,version)`.
- [ ] Step 3: **Decisions queue** — `GET /adrs?status=draft`; render `AdrRow`; Ratify → `ratifyAdr(id)`.
- [ ] Step 4: **Triage queue** — `GET /needs-triage`; render `NeedsTriageRow` (raw/reason/source_author). **Assign/Discard inert + report (no write route).**
- [ ] Step 5: **Milestone proposals** — `GET /milestone-proposals`; Promote → `promoteMilestoneProposal(id)`. (Surface where the design shows them, or as a sub-list; report placement.)
- [ ] Step 6: refresh-after-confirm — re-fetch the affected queue/view so the flip shows.
- [ ] Step 7: 401→auth, 403→inline.
- [ ] Step 8: delete triage mocks; typecheck.
- [ ] Step 9: verify the DoD confirm:
```bash
COOKIE=$(node scripts/dev-cookie.mjs)
curl -s -H "Cookie:$COOKIE" http://localhost:8787/doc/mcp-server | grep -o '"current_version":[0-9]*'      # 2
curl -s -H "Cookie:$COOKIE" -X POST -H "content-type: application/json" -d '{"version":3}' \
     http://localhost:8787/doc/mcp-server/promote                                                          # {"ok":true,...}
curl -s -H "Cookie:$COOKIE" http://localhost:8787/doc/mcp-server | grep -o '"current_version":[0-9]*'      # 3
```
- [ ] Step 10: commit `feat(web): wire Triage reads + cookie-authed confirms`.

## Task 6: AUTH + SETTINGS → real session
**Files:** `api.ts` (`me`,`logout`,`mintMcpToken`), `main.ts`, `render.ts`, `data.ts` (delete `initTokens`,`Token`,`people`).
- [ ] Step 1: boot → `GET /auth/me`; 200 → app + populate sidebar chip / Settings profile (`login,name,org`); 401 → login screen. "Sign in" → `location="/auth/login"`.
- [ ] Step 2: **non-member** — if `location.search` has `denied=1` → render the locked-door screen (driven by B5 redirect).
- [ ] Step 3: Sign out → `logout()` → login screen.
- [ ] Step 4: Settings mint → `mintMcpToken()` → show raw token ONCE in the reveal panel; never store. **Token list + Revoke: no route → list shows only freshly minted; Revoke inert; report.**
- [ ] Step 5: profile "Member of {org}" from `/auth/me.org`. Theme switch already works (leave it).
- [ ] Step 6: delete auth/settings mocks; typecheck. Confirm `data.ts` is empty/near-empty (zero surviving contract types).
- [ ] Step 7: verify `/auth/me`, `/auth/mcp-token`, `/auth/logout`; shots login-vs-app + `?denied=1`. Commit `feat(web): wire auth + settings to real session`.

## Task 7: Final sweep
- [ ] Step 1: `grep -rn "interface\|type .*=" web/src/data.ts` — no contract/row types remain (delete `data.ts` if empty).
- [ ] Step 2: `npm run typecheck` clean.
- [ ] Step 3: `npm test` green (new + old).
- [ ] Step 4: `npm run build:web` clean; `wrangler dev` serves one origin; ASSETS=`web/dist`.
- [ ] Step 5: commit `chore(web): Phase-2 type-cleanup sweep`.

---

## Self-Review
**Coverage:** Tasks 1–6 ↔ the six spec steps; Phase 2a (B1–B5) unblocks Triage/Settings per the approved scope; Task 0 enables verification; Task 7 enforces kill-duplicate-types.
**Type consistency:** `api.ts` is the single source of route shapes; rows from `@shared/rows`; envelopes/`SearchResult`/`progress` re-declared once in `api.ts`. Confirm fns: `promoteDoc`/`ratifyAdr`/`promoteMilestoneProposal`/`completeMilestone`; reads: `listDocs`/`getDoc`/`getFeed`/`search`/`getRoadmap`/`listAdrs`/`listNeedsTriage`/`listMilestoneProposals`/`me`.
**Still-open (report, build nothing):** G1, G2, G3, G4, G5, G11, needs_triage assign/discard, MCP-token list/revoke. G9 uses the N+1 workaround. Code-vs-prompt: read uses `rows.ts` not `contract.ts`; response envelopes not in `@shared`.
**Cookie-vs-bearer:** all UI fetches `credentials:"same-origin"`; bearer never in the UI.
