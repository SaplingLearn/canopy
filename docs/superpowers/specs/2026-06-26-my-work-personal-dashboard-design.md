# Design: "My Work" — a personal dashboard page

_Date: 2026-06-26 · Status: approved for planning_

## Goal

Give each signed-in user a personal landing page that answers two questions at a
glance: **what am I working on now**, and **what do I have to work on soon**. It
becomes the default screen after login.

## Data sources

Three sources, all read-only and personalized to the authenticated principal:

1. **Recent feed activity** — the user's own Canopy feed entries, newest first
   (already queryable via the `feed.author` column).
2. **Roadmap assignments** — parsed live from `ROADMAP.md` in
   **`SaplingLearn/sapling`** (the project's real content repo — NOT the
   `GITHUB_REPO` var, which points at `…/canopy`). The file has time-phased
   sprint sections (`Now → Next 2 Weeks`, `Weeks 3–4`, `July`, `August`,
   `September`) with one bullet **per person**, plus a Team & Responsibilities
   table. These bullets are the "now / soon" narrative, written by name.
3. **Live assigned GitHub issues** — open issues assigned to the user's GitHub
   login in `SaplingLearn/sapling`, fetched live via the user's stored token.

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

If the token is missing/expired/revoked: set `degraded: true`, return
`workingNow: null`, `comingUp: []`, `assignedIssues: []`, but **still return the
feed**. Never throw a 500 — identical philosophy to `roadmap.ts` returning
milestones without progress.

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

export interface DashboardData {
  person: string | null;        // mapped roadmap name; null if unmapped
  role: string | null;          // from Team & Responsibilities
  owns: string | null;          // from Team & Responsibilities ("Owns" column)
  workingNow: RoadmapPhase | null;
  comingUp: RoadmapPhase[];
  assignedIssues: AssignedIssue[];
  feed: FeedRow[];              // capped (~8) most-recent
  degraded: boolean;           // GitHub data unavailable (no/expired token)
}
```

### Login map

`src/people.ts` exports the hardcoded `LOGIN_TO_PERSON` record and a
`loginToPerson(login): string | null` helper. Backend-only (the web receives the
resolved `person` in the payload).

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

WORKING ON NOW                         <phase title> (<window>)
  <bullet text, with #NNN as GitHub-linked chips>

COMING UP
  • <phase title> — <bullet>
  • <phase title> — <bullet>

ASSIGNED TO YOU (live · N open)
  [P0] #124 <title>                                   <labels>
  [P1] #74  <title>                                   <labels>

YOUR RECENT ACTIVITY
  • <feed summary> — <relative time>   (links to PRs/issues as today)
```

Sections with no data render a quiet empty state. When `degraded`, the roadmap
and assigned-issues sections show a one-line "connect/refresh GitHub" note
instead of erroring; the feed still renders.

## Testing (TDD, real Miniflare D1)

- **Unit** (`parseRoadmapForPerson`): use the real `ROADMAP.md` as a fixture.
  Assert Andres → correct `workingNow` (Weeks 3–4 for `today=2026-06-26`),
  `comingUp` (July/Aug/Sep), extracted issue refs, role/owns. Assert an unmapped
  person yields nulls. Assert the no-dates fallback selects the first phase.
- **Unit** (issue parsing): `[P0]`/labels parsed; PR items filtered out.
- **Unit** (`loginToPerson`): all four mappings + unknown → null.
- **Integration** (`GET /me/dashboard`): inject `fetchImpl` stubbing the GitHub
  contents + issues responses; assert the assembled payload. Assert the
  **degraded path** (no token) returns feed-only with `degraded:true` and no 500.
- `npm run typecheck` must pass (it is not part of `npm test`).

## Out of scope (YAGNI)

- No new DB tables, migrations, or writes (pure reads).
- No MCP tool for this surface.
- No assignee model inside Canopy (GitHub remains the source of "assigned").
- No "I am __ on the roadmap" settings selector (hardcoded map instead).
- No caching layer; computed live per request like the roadmap.
```
