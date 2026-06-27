# Design: "My Work" — a personal dashboard page

_Date: 2026-06-26 · Status: approved for planning_

## Goal

Give each signed-in user a personal landing page that answers two questions at a
glance: **what am I working on now**, and **what do I have to work on soon**. It
becomes the default screen after login.

The page has two halves: a **read** side (the dashboard) and a **write** side
that keeps the headline fresh — at session end, the existing `record-session`
skill also records the person's current **focus**, so "working on now / next up"
reflects the latest session, not just the last time someone hand-edited the
roadmap.

## Data sources

Four sources, all personalized to the authenticated principal:

1. **Focus status** — the person's self-reported "working on now" + "next up",
   written at session end (see *Session-end focus update*). Stored in Canopy;
   this is the **headline** when present.
2. **Roadmap assignments** — parsed live from `ROADMAP.md` in
   **`SaplingLearn/sapling`** (the project's real content repo — NOT the
   `GITHUB_REPO` var, which points at `…/canopy`). The file has time-phased
   sprint sections (`Now → Next 2 Weeks`, `Weeks 3–4`, `July`, `August`,
   `September`) with one bullet **per person**, plus a Team & Responsibilities
   table. These bullets are the "now / soon" narrative, written by name. Shown as
   **supporting context** below the focus headline (and used as the headline
   fallback when no focus has been set yet).
3. **Live assigned GitHub issues** — open issues assigned to the user's GitHub
   login in `SaplingLearn/sapling`, fetched live via the user's stored token.
4. **Recent feed activity** — the user's own Canopy feed entries, newest first
   (already queryable via the `feed.author` column).

## Identity mapping

The roadmap refers to people by first name; the session knows a GitHub login. A
**hardcoded** map (per the team's small, stable size) resolves login → person:

```
AndresL230            → Andres
Jose-Gael-Cruz-Lopez  → Jose
lpcooper-arch         → Luke
Darkest-Teddy         → Jack
```

A signed-in user **not** in the map still gets feed + assigned issues; the
roadmap section is omitted with a gentle note ("You're not on the roadmap yet").

## Architecture — one server-side aggregation endpoint

Chosen approach (of three considered):

- **A — single `GET /me/dashboard` (chosen).** The Worker queries the feed from
  D1, fetches+parses `ROADMAP.md`, and fetches assigned issues — all using the
  principal's sealed token — and returns one structured JSON payload. Mirrors the
  existing "roadmap computed live, stored nowhere" pattern in
  `src/tools/roadmap.ts`. The token never leaves the server; the web layer stays
  thin (one screen, one loader); partial failures degrade per-section.
- B — web calls three endpoints. Rejected: more endpoints, more round trips, more
  client orchestration for no benefit.
- C — web calls GitHub directly. Rejected outright: the GitHub token is AES-GCM
  sealed server-side and is never sent to the client, by design.

This endpoint is **HTTP/session-only — never an MCP tool** (it is a human page,
consistent with the rule that human-facing surfaces aren't MCP tools).

## Backend

### New var

Add `CONTENT_REPO` to `[vars]` in `wrangler.toml`, default `SaplingLearn/sapling`,
and to the `Env` type in `src/env.ts`. Code falls back to the literal
`"SaplingLearn/sapling"` when the var is absent (keeps tests/dev working). The
existing `GITHUB_REPO` and the roadmap feature are left untouched.

### New route

`GET /me/dashboard` (session-gated, registered in `src/routes.ts`). Resolves the
principal, unseals the GitHub token using the **same helper `GET /roadmap`
already uses**, calls the aggregator, returns `DashboardData` JSON. Never 500s on
GitHub failure — see degradation below.

### New module `src/tools/dashboard.ts`

- `getMyDashboard(db, principal, token, repo, today, fetchImpl?) → DashboardData`
  — orchestrates the three sources and assembles the payload.
- `parseRoadmapForPerson(markdown, person, today) → { role, owns, workingNow, comingUp }`
  — **pure, unit-tested**. Logic:
  - Read the person's row from the **Team & Responsibilities** table → `role`,
    `owns`.
  - Collect the **time-phased** `##` sections — a section qualifies if its
    heading contains a parenthetical date range, starts with "Now", or contains a
    month name (excludes "Team & Responsibilities" and "Issue tracking …").
    Document order is treated as chronological.
  - For each phase, capture this person's bullet — the `- **<Name>** — …` item
    including wrapped continuation lines until the next bullet/heading — as one
    cleaned string, and extract `#\d+` issue refs.
  - **Current phase** = the last phase whose parsed **start date ≤ `today`**. A
    missing start is treated as "early" (so end-only phases qualify), but a later
    phase that also qualifies wins. Month-only headings infer the year from
    `today` (month earlier than today's month ⇒ next year). If no dates parse,
    fall back to the first phase.
  - `workingNow` = the current phase's entry; `comingUp` = phases after it;
    phases before it (past) are dropped. Phases where the person has no bullet are
    skipped.
- `listAssignedIssues(token, repo, login, fetchImpl) → AssignedIssue[]`
  — `GET /repos/{repo}/issues?assignee={login}&state=open&per_page=50`. Filters
  out PRs (items carrying a `pull_request` field). Parses a leading `[P0]`–`[P3]`
  priority tag from the title and the issue's labels.

`fetchImpl?: typeof fetch` is dependency-injected for tests (the project never
hits the network in tests; GitHub I/O is stubbed at the `Response` level).

### Graceful degradation

The `token` argument is `string | null`. If it is missing/expired/revoked: set
`degraded: true`, return `workingNow: null`, `comingUp: []`,
`assignedIssues: []`, but **still return `focus` and `feed`** (both are D1-backed
and token-independent). Never throw a 500 — identical philosophy to `roadmap.ts`
returning milestones without progress.

### Response contract — `shared/dashboard.ts`

A new shared module (the only cross-layer location), imported by both the Worker
and the web `api.ts` so the shape is agreed in one place.

```ts
import type { FeedRow } from "./rows";

export interface RoadmapPhase {
  title: string;          // "Weeks 3–4"
  window: string | null;  // raw parenthetical, e.g. "~2026-06-22 → 2026-07-05"
  bullet: string;         // the person's cleaned bullet text
  issueRefs: number[];    // [138, 132]
}

export interface AssignedIssue {
  number: number;
  title: string;                         // priority tag stripped
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface Focus {
  workingOn: string;
  nextUp: string | null;
  updatedAt: string;           // ISO
}

export interface DashboardData {
  person: string | null;        // mapped roadmap name; null if unmapped
  role: string | null;          // from Team & Responsibilities
  owns: string | null;          // from Team & Responsibilities ("Owns" column)
  focus: Focus | null;          // self-reported headline; null until first set
  workingNow: RoadmapPhase | null;   // roadmap "now" (supporting context / fallback)
  comingUp: RoadmapPhase[];          // roadmap upcoming phases
  assignedIssues: AssignedIssue[];
  feed: FeedRow[];              // capped (~8) most-recent
  degraded: boolean;           // GitHub data unavailable (no/expired token)
}
```

`getMyDashboard` also reads the principal's `focus` row from D1 (always available,
independent of the GitHub token) and includes it. The `focus` read is **not**
subject to `degraded` — only the GitHub-derived roadmap/issues are.

### Login map

`src/people.ts` exports the hardcoded `LOGIN_TO_PERSON` record and a
`loginToPerson(login): string | null` helper. Backend-only (the web receives the
resolved `person` in the payload).

## Session-end focus update (the write side)

Keeps the dashboard headline fresh. A new **per-person focus row**, upserted at
session end through the gate — the same producer→gate contract the feed uses.

### Data model — `migrations/0007_focus.sql`

One current focus per person (upsert; the feed is the history, so no focus
history is kept):

```sql
CREATE TABLE focus (
  author      TEXT PRIMARY KEY,   -- the authenticated principal's login
  working_on  TEXT NOT NULL,      -- "what I'm working on now"
  next_up     TEXT,               -- "what's next" (nullable)
  updated_at  TEXT NOT NULL       -- ISO timestamp (db.ts nowIso())
);
```

Add a matching `FocusRow` to `shared/rows.ts` (one type per table) and add
`DELETE FROM focus;` to the `beforeEach` truncation in `test/apply-migrations.ts`.

### Gate function + contract

- `shared/contract.ts`: add a `FocusUpdate` Zod schema
  (`working_on: non-empty string`, `next_up: optional string`).
- `src/consumer.ts`: add `ingestFocusUpdate(db, update, author)` following the
  existing `ingestX(db, entry, author)` gate shape. Focus is a **direct write**
  (an upsert), like the feed — not a staged proposal: it is low-stakes
  self-report, so it needs no human confirmation. (The "agents stage, humans
  confirm" rule governs the *consequential* surfaces — docs, ADRs, milestones.
  Feed and now focus are the agent-direct writes, and both still go through a
  gate.) **Author is always the principal**; any client-supplied author is
  ignored. The DB write lives in `src/tools/writes.ts` as `set_focus(...)`
  (upsert on `author`).
- This is **not** a second write surface — `set_focus` (MCP) → `ingestFocusUpdate`
  (gate) → `writes.ts`, exactly mirroring `append_feed` → `ingestFeedEntry`.
  Focus is singular (not a batch), so it is **not** added to the array-shaped
  `IngestPayload`/`consume`; its only entry point is the MCP tool below.

### MCP tool

`src/mcp.ts`: add `set_focus({ working_on, next_up? })`, a thin adapter that
validates via `FocusUpdate`, resolves the author from the bearer principal, and
calls `ingestFocusUpdate`. It is a write tool (like `append_feed`), **not** a
human-confirm route.

### `record-session` skill extension

Extend `.claude/skills/record-session/SKILL.md`:

- Add `mcp__canopy__set_focus` to `allowed-tools`.
- Add a step after the feed entry is written: capture the person's **current
  focus** — `working_on` summarized from what the session actually advanced
  (consistent with the skill's "prose body may summarize intent"), `next_up` from
  the clearly-stated next step — and call `set_focus` once per explicit wrap-up
  request. `working_on`/`next_up` are forward-looking prose (intent), so they are
  exempt from the "artifacts are observed" rule, which still binds the feed
  entry's artifacts. Same trigger and cadence as recording the session (explicit
  ask only; never auto-fire).

## Frontend (web/)

A new `"mywork"` screen following the existing vanilla-TS pattern
(state → dispatch → rerender; string-built HTML; inline styles + CSS tokens).

- `Screen` union (`render.ts`): add `"mywork"`.
- `AppState`: add `mywork: Loadable<DashboardData>`.
- `api.ts`: `getMyDashboard(): Promise<DashboardData>` → `GET /me/dashboard`
  (import `DashboardData` from `@shared/dashboard`).
- `main.ts`: `goMyWork` dispatch + `loadMyWorkIfNeeded()` loader (same
  loading/error/Unauthorized handling as other loaders).
- `render.ts`: `myWorkView(s)` renders the sections; add a sidebar nav item
  **"My Work"** at the **top** of the nav; wire into the `screenBody` switch.
- **Default screen**: initial `state.screen` is `"mywork"`, and the post-login
  boot path loads it first. Feed remains one click away.

### Layout

```
Good <time-of-day>, <Name>
<role> · owns: <owns>

WORKING ON NOW                         updated <relative time>
  <focus.workingOn, with #NNN as GitHub-linked chips>
NEXT UP
  <focus.nextUp>

FROM THE ROADMAP                       <phase title> (<window>)
  <roadmap workingNow bullet>
  Coming up:
   • <phase title> — <bullet>
   • <phase title> — <bullet>

ASSIGNED TO YOU (live · N open)
  [P0] #124 <title>                                   <labels>
  [P1] #74  <title>                                   <labels>

YOUR RECENT ACTIVITY
  • <feed summary> — <relative time>   (links to PRs/issues as today)
```

- **Headline**: when `focus` is set, "Working on now / Next up" comes from it
  (with an "updated <relative time>" stamp). When `focus` is null, the headline
  falls back to the roadmap's `workingNow`, and the "From the roadmap" block is
  not duplicated.
- Sections with no data render a quiet empty state. When `degraded`, the roadmap
  and assigned-issues sections show a one-line "connect/refresh GitHub" note
  instead of erroring; the focus headline and the feed still render (both are
  D1-backed, not token-dependent).

## Testing (TDD, real Miniflare D1)

- **Unit** (`parseRoadmapForPerson`): use the real `ROADMAP.md` as a fixture.
  Assert Andres → correct `workingNow` (Weeks 3–4 for `today=2026-06-26`),
  `comingUp` (July/Aug/Sep), extracted issue refs, role/owns. Assert an unmapped
  person yields nulls. Assert the no-dates fallback selects the first phase.
- **Unit** (issue parsing): `[P0]`/labels parsed; PR items filtered out.
- **Unit** (`loginToPerson`): all four mappings + unknown → null.
- **Integration** (`GET /me/dashboard`): inject `fetchImpl` stubbing the GitHub
  contents + issues responses; assert the assembled payload. Assert the
  **degraded path** (no token) returns focus + feed with `degraded:true`, empty
  roadmap/issues, and no 500.
- **Focus write path**: `ingestFocusUpdate` / `set_focus` upserts one row per
  author (second write overwrites, not duplicates); the **author is the
  principal** and a client-supplied author is ignored; `FocusUpdate` rejects an
  empty `working_on`. Then `GET /me/dashboard` returns the written `focus` as the
  headline, and falls back to the roadmap `workingNow` when no focus row exists.
- `npm run typecheck` must pass (it is not part of `npm test`).

## Out of scope (YAGNI)

- The **only** new table/migration/write is the `focus` upsert. The dashboard
  read itself adds no tables and stores nothing.
- No focus **history** (the feed is the history); `focus` holds one current row
  per person, overwritten each session.
- No HTTP `/ingest` (batch `consume`) path for focus — the `set_focus` MCP tool
  is its sole entry point.
- No human-confirm route for focus (it is a direct, self-reported write, like the
  feed).
- No assignee model inside Canopy (GitHub remains the source of "assigned").
- No "I am __ on the roadmap" settings selector (hardcoded map instead).
- No caching layer; the GitHub-derived data is computed live per request like the
  roadmap.
```
