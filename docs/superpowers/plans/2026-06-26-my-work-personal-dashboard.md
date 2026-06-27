# My Work Personal Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal "My Work" dashboard page that shows the signed-in user their current focus, roadmap assignments, live assigned GitHub issues, and recent feed activity — kept fresh by a session-end focus write.

**Architecture:** One server-side aggregation endpoint `GET /me/dashboard` reads the user's feed + focus from D1 and, using the user's sealed GitHub token, parses `SaplingLearn/sapling/ROADMAP.md` and fetches their assigned issues — returning one `DashboardData` payload (degrades gracefully, never 500s). A new gated `set_focus` MCP tool (upsert, like the feed) lets the existing `record-session` skill record what the person is working on. The web adds one screen following the existing vanilla-TS state→dispatch→rerender pattern.

**Tech Stack:** Cloudflare Workers + Hono, D1 (SQLite) via `src/db.ts` helpers, Zod contracts in `shared/`, MCP via `@modelcontextprotocol/sdk`, vanilla-TS web build (Vite), Vitest against real Miniflare D1.

## Global Constraints

- **Single gated write path:** every write funnels through a gate function in `src/consumer.ts`; MCP tools are thin adapters over the gate. Never add a second write surface. (`set_focus` MCP → `ingestFocusUpdate` gate → `writes.ts`.)
- **Author is always the authenticated principal**, passed in by the caller; any client-supplied author is ignored.
- **GitHub I/O is dependency-injected** via `fetchImpl?: typeof fetch`; tests stub at the `Response` level and never hit the network.
- **Never 500 on GitHub failure** — degrade (return D1-backed data, empty GitHub-derived data, `degraded:true`).
- **`shared/` is the only cross-layer import** (`@shared/*`), used by both `src/` and `web/`. `web/` cannot import `src/`.
- **Content repo is `SaplingLearn/sapling`** (NOT the `GITHUB_REPO` var, which is `…/canopy`). Use `env.CONTENT_REPO ?? "SaplingLearn/sapling"`.
- **`npm test`** (Vitest/Miniflare D1) is the source of truth for green; **`npm run typecheck`** must also pass (it is NOT part of `npm test`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Created:**
- `shared/dashboard.ts` — DTO types shared by worker + web (`RoadmapPhase`, `AssignedIssue`, `Focus`, `DashboardData`).
- `src/people.ts` — hardcoded GitHub-login → roadmap-person map.
- `src/tools/dashboard.ts` — roadmap parsing, assigned-issue fetch, aggregator.
- `migrations/0007_focus.sql` — the `focus` table.
- Test files per task under `test/`.

**Modified:**
- `shared/contract.ts` — add `FocusUpdate` schema.
- `shared/rows.ts` — add `FocusRow`.
- `src/tools/writes.ts` — add `set_focus` upsert.
- `src/tools/reads.ts` — add `get_focus`.
- `src/consumer.ts` — add `ingestFocusUpdate` gate.
- `src/mcp.ts` — register `set_focus` tool.
- `src/routes.ts` — add `GET /me/dashboard`.
- `src/env.ts` + `wrangler.toml` — add `CONTENT_REPO`.
- `test/apply-migrations.ts` — truncate `focus`.
- `web/src/api.ts`, `web/src/render.ts`, `web/src/main.ts`, `web/src/canopy.css` — the My Work screen.
- `.claude/skills/record-session/SKILL.md` — focus-capture step.
- `scripts/seed-dev.sql` — focus + feed rows for local preview.

---

### Task 1: Shared DTO types + FocusUpdate contract

**Files:**
- Create: `shared/dashboard.ts`
- Modify: `shared/contract.ts`
- Test: `test/focus-contract.test.ts`

**Interfaces:**
- Produces: `RoadmapPhase`, `AssignedIssue`, `Focus`, `DashboardData` (from `@shared/dashboard`); `FocusUpdate` Zod schema + type (from `@shared/contract`).

- [ ] **Step 1: Create the shared DTO types**

Create `shared/dashboard.ts`:

```ts
// DTOs for the personal "My Work" dashboard. Lives in shared/ (the only cross-layer
// location) so the Worker (src/) and the web build (web/) agree on the shape.
import type { FeedRow } from "./rows";

export interface RoadmapPhase {
  title: string;          // e.g. "Weeks 3–4"
  window: string | null;  // raw parenthetical, e.g. "~2026-06-22 → 2026-07-05"
  bullet: string;         // the person's cleaned bullet text
  issueRefs: number[];    // GitHub issue numbers mentioned, in order
}

export interface AssignedIssue {
  number: number;
  title: string;                          // priority tag stripped
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface Focus {
  workingOn: string;
  nextUp: string | null;
  updatedAt: string;      // ISO
}

export interface DashboardData {
  person: string | null;        // mapped roadmap name; null if unmapped
  role: string | null;          // from Team & Responsibilities
  owns: string | null;          // from Team & Responsibilities ("Owns" column)
  focus: Focus | null;          // self-reported headline; null until first set
  workingNow: RoadmapPhase | null;   // roadmap "now" (context / headline fallback)
  comingUp: RoadmapPhase[];          // roadmap upcoming phases
  assignedIssues: AssignedIssue[];
  feed: FeedRow[];              // capped (~8) most-recent
  degraded: boolean;           // GitHub-derived data unavailable (no/expired token)
}
```

- [ ] **Step 2: Add the FocusUpdate contract**

In `shared/contract.ts`, after the `MilestoneProposal` schema block (before the `IngestPayload` schema), add:

```ts
export const FocusUpdate = z.object({
  working_on: z.string().min(1),
  next_up: z.string().optional(),
});
```

And in the type-export block at the bottom, after `export type MilestoneProposal = ...`, add:

```ts
export type FocusUpdate = z.infer<typeof FocusUpdate>;
```

- [ ] **Step 3: Write the failing test**

Create `test/focus-contract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FocusUpdate } from "@shared/contract";

describe("FocusUpdate contract", () => {
  it("accepts working_on with optional next_up", () => {
    expect(FocusUpdate.parse({ working_on: "ship dashboard", next_up: "tests" }))
      .toEqual({ working_on: "ship dashboard", next_up: "tests" });
    expect(FocusUpdate.parse({ working_on: "x" }).next_up).toBeUndefined();
  });
  it("rejects an empty or missing working_on", () => {
    expect(FocusUpdate.safeParse({ working_on: "" }).success).toBe(false);
    expect(FocusUpdate.safeParse({ next_up: "y" }).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/focus-contract.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/dashboard.ts shared/contract.ts test/focus-contract.test.ts
git commit -m "feat(shared): add DashboardData DTOs and FocusUpdate contract" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Focus storage + write gate + MCP tool

**Files:**
- Create: `migrations/0007_focus.sql`
- Modify: `shared/rows.ts`, `src/tools/writes.ts`, `src/tools/reads.ts`, `src/consumer.ts`, `src/mcp.ts`, `test/apply-migrations.ts`
- Test: `test/focus-write.test.ts`

**Interfaces:**
- Consumes: `FocusUpdate` (Task 1).
- Produces: `set_focus(db, { author, working_on, next_up? }): Promise<void>` (writes.ts); `get_focus(db, author): Promise<FocusRow | null>` (reads.ts); `ingestFocusUpdate(db, update: FocusUpdate, author: string): Promise<{ outcome: "written" }>` (consumer.ts); `FocusRow` (rows.ts); MCP `set_focus` tool.

- [ ] **Step 1: Create the migration**

Create `migrations/0007_focus.sql`:

```sql
-- Per-person "current focus" for the personal dashboard. One row per author
-- (upsert); the feed is the history, so no focus history is kept here.
CREATE TABLE focus (
  author      TEXT PRIMARY KEY,
  working_on  TEXT NOT NULL,
  next_up     TEXT,
  updated_at  TEXT NOT NULL
);
```

- [ ] **Step 2: Add the FocusRow type**

In `shared/rows.ts`, append:

```ts
export interface FocusRow {
  author: string;
  working_on: string;
  next_up: string | null;
  updated_at: string;
}
```

- [ ] **Step 3: Add the writer (upsert)**

In `src/tools/writes.ts`, append (after `complete_milestone`):

```ts
/** Upsert the author's current focus. One row per person — a re-write overwrites it. */
export async function set_focus(
  db: DB,
  focus: { author: string; working_on: string; next_up?: string | null }
): Promise<void> {
  await run(
    db,
    `INSERT INTO focus (author, working_on, next_up, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(author) DO UPDATE SET
       working_on = excluded.working_on,
       next_up    = excluded.next_up,
       updated_at = excluded.updated_at`,
    focus.author,
    focus.working_on,
    focus.next_up ?? null,
    nowIso()
  );
}
```

- [ ] **Step 4: Add the reader**

In `src/tools/reads.ts`, change the import on line 1 to include `FocusRow`:

```ts
import type { DocRow, DocVersionRow, FeedRow, AdrRow, NeedsTriageRow, MilestoneProposalRow, FocusRow } from "@shared/rows";
```

Then append at the end of the file:

```ts
export async function get_focus(db: DB, author: string): Promise<FocusRow | null> {
  return first<FocusRow>(db, `SELECT * FROM focus WHERE author = ?`, author);
}
```

- [ ] **Step 5: Add the gate function**

In `src/consumer.ts`, update the two imports at the top:

```ts
import type { IngestPayload, FeedEntry, DocProposal, AdrDraft, MilestoneProposal, FocusUpdate } from "@shared/contract";
```
```ts
import { append_feed, propose_doc_update, stage_adr, route_triage, stage_milestone_proposal, set_focus } from "./tools/writes";
```

Then, after `ingestMilestoneProposal` (before the `consume` function), add:

```ts
/** Focus: a direct per-person upsert (like the feed, not staged — it is low-stakes
 *  self-report needing no human confirmation). Author is always the principal. */
export async function ingestFocusUpdate(
  db: DB,
  update: FocusUpdate,
  author: string
): Promise<{ outcome: "written" }> {
  await set_focus(db, { author, working_on: update.working_on, next_up: update.next_up ?? null });
  return { outcome: "written" };
}
```

- [ ] **Step 6: Register the MCP tool**

In `src/mcp.ts`, update the consumer import on line 9:

```ts
import { ingestFeedEntry, ingestDocProposal, ingestMilestoneProposal, ingestFocusUpdate } from "./consumer";
```

Then, after the `propose_milestone` tool registration (before the `createMcpHandler` line), add:

```ts
  server.tool(
    "set_focus",
    "Set your current focus for the personal dashboard: what you're working on now and (optionally) what's next. Upserts one row per person — overwrites your previous focus.",
    { working_on: z.string(), next_up: z.string().optional() },
    async ({ working_on, next_up }) =>
      runTool(() => ingestFocusUpdate(env.DB, { working_on, next_up }, principal.login))
  );
```

- [ ] **Step 7: Add focus to the test truncation list**

In `test/apply-migrations.ts`, replace the `env.DB.exec(...)` string so it also clears `focus` (add `DELETE FROM focus;` at the front):

```ts
  await env.DB.exec(
    "DELETE FROM focus; DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
  );
```

- [ ] **Step 8: Write the failing test**

Create `test/focus-write.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ingestFocusUpdate } from "../src/consumer";
import { get_focus } from "../src/tools/reads";
import { all } from "../src/db";
import type { FocusRow } from "@shared/rows";

describe("focus write path (set_focus → ingestFocusUpdate)", () => {
  it("upserts one row per author; a re-write overwrites (no duplicate)", async () => {
    const r = await ingestFocusUpdate(env.DB, { working_on: "wire dashboard", next_up: "tests" }, "andres");
    expect(r.outcome).toBe("written");

    let row = await get_focus(env.DB, "andres");
    expect(row?.working_on).toBe("wire dashboard");
    expect(row?.next_up).toBe("tests");

    await ingestFocusUpdate(env.DB, { working_on: "ship dashboard" }, "andres");
    row = await get_focus(env.DB, "andres");
    expect(row?.working_on).toBe("ship dashboard");
    expect(row?.next_up).toBeNull();

    expect(await all<FocusRow>(env.DB, `SELECT * FROM focus`)).toHaveLength(1);
  });

  it("stores under the passed-in author, and returns null for an author with no focus", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "x" }, "luke");
    expect((await get_focus(env.DB, "luke"))?.author).toBe("luke");
    expect(await get_focus(env.DB, "nobody")).toBeNull();
  });
});
```

- [ ] **Step 9: Run the test**

Run: `npx vitest run test/focus-write.test.ts`
Expected: PASS (both cases). If it fails with "no such table: focus", confirm the migration filename is exactly `migrations/0007_focus.sql`.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add migrations/0007_focus.sql shared/rows.ts src/tools/writes.ts src/tools/reads.ts src/consumer.ts src/mcp.ts test/apply-migrations.ts test/focus-write.test.ts
git commit -m "feat(focus): add focus table, gate, and set_focus MCP tool" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Login → roadmap-person map

**Files:**
- Create: `src/people.ts`
- Test: `test/people.test.ts`

**Interfaces:**
- Produces: `loginToPerson(login: string): string | null`; `LOGIN_TO_PERSON: Record<string, string>`.

- [ ] **Step 1: Create the map**

Create `src/people.ts`:

```ts
// Maps a GitHub login to the person's first name as used in SaplingLearn/sapling's
// ROADMAP.md (the Team & Responsibilities table and the per-person sprint bullets).
// Hardcoded for the small, stable team; an unmapped login simply gets no roadmap section.
export const LOGIN_TO_PERSON: Record<string, string> = {
  AndresL230: "Andres",
  "Jose-Gael-Cruz-Lopez": "Jose",
  "lpcooper-arch": "Luke",
  "Darkest-Teddy": "Jack",
};

export function loginToPerson(login: string): string | null {
  return LOGIN_TO_PERSON[login] ?? null;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/people.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loginToPerson } from "../src/people";

describe("loginToPerson", () => {
  it("maps the four known logins to roadmap first names", () => {
    expect(loginToPerson("AndresL230")).toBe("Andres");
    expect(loginToPerson("Jose-Gael-Cruz-Lopez")).toBe("Jose");
    expect(loginToPerson("lpcooper-arch")).toBe("Luke");
    expect(loginToPerson("Darkest-Teddy")).toBe("Jack");
  });
  it("returns null for an unknown login", () => {
    expect(loginToPerson("octo-stranger")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/people.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/people.ts test/people.test.ts
git commit -m "feat(people): add login to roadmap-person map" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: parseRoadmapForPerson

**Files:**
- Create: `src/tools/dashboard.ts`
- Test: `test/dashboard-parse.test.ts`

**Interfaces:**
- Consumes: `RoadmapPhase` (Task 1).
- Produces: `parseRoadmapForPerson(markdown: string, person: string, today: string): { role: string | null; owns: string | null; workingNow: RoadmapPhase | null; comingUp: RoadmapPhase[] }`. Also exports the helper `escapeRegExp` is internal (not exported).

- [ ] **Step 1: Create the parser module**

Create `src/tools/dashboard.ts`:

```ts
import type { RoadmapPhase } from "@shared/dashboard";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A "## " heading is a time-phased sprint section if it starts with "Now", carries a
 *  parenthetical with a year, or names a month. Excludes meta sections (Team table, etc.). */
function isTimePhased(heading: string): boolean {
  if (/^Now\b/i.test(heading)) return true;
  if (/\([^)]*\d{4}[^)]*\)/.test(heading)) return true;
  return MONTHS.some((m) => new RegExp(`(^|\\s)${m}\\b`, "i").test(heading));
}

/** Split "Weeks 3–4 (~2026-06-22 → 2026-07-05)" into title + window (parenthetical, no parens). */
function splitTitleWindow(heading: string): { title: string; window: string | null } {
  const m = heading.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { title: m[1].trim(), window: m[2].trim() };
  return { title: heading.trim(), window: null };
}

/** A phase's start time in ms. A range "A → B" uses A; an end-only "through B" or a
 *  date-less heading is treated as -Infinity (early); a month-only heading uses the 1st
 *  of that month, inferring the year from `today`. */
function phaseStartMs(title: string, window: string | null, today: string): number {
  const w = window ?? "";
  const dates = w.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const hasArrow = /→|->/.test(w);
  if (hasArrow && dates.length >= 1) return Date.parse(dates[0] + "T00:00:00Z");
  if (!hasArrow && dates.length === 1 && !/through/i.test(w)) return Date.parse(dates[0] + "T00:00:00Z");
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`(^|\\s)${m}\\b`, "i").test(title));
  if (monthIdx >= 0) {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7)); // 1-12
    const year = monthIdx + 1 < tm ? ty + 1 : ty;
    return Date.parse(`${year}-${String(monthIdx + 1).padStart(2, "0")}-01T00:00:00Z`);
  }
  return -Infinity;
}

export interface ParsedRoadmap {
  role: string | null;
  owns: string | null;
  workingNow: RoadmapPhase | null;
  comingUp: RoadmapPhase[];
}

/** Parse a person's role/owns + their now/upcoming bullets out of ROADMAP.md. Pure. */
export function parseRoadmapForPerson(markdown: string, person: string, today: string): ParsedRoadmap {
  const lines = markdown.split(/\r?\n/);

  // role / owns: the Team & Responsibilities table row has the person bolded in column 1.
  let role: string | null = null;
  let owns: string | null = null;
  const teamRe = new RegExp(`^\\|\\s*\\*\\*${escapeRegExp(person)}\\*\\*\\s*\\|`);
  const teamRow = lines.find((l) => teamRe.test(l));
  if (teamRow) {
    const cells = teamRow.split("|").map((c) => c.trim()); // ["", "**Andres**", "Fullstack", "Owns…", ""]
    role = cells[2] || null;
    owns = cells[3] || null;
  }

  // index every "## " heading, then walk each time-phased section.
  const headingIdx: number[] = [];
  lines.forEach((l, i) => { if (/^##\s+/.test(l)) headingIdx.push(i); });

  interface RawPhase { title: string; window: string | null; start: number; bullet: string; issueRefs: number[]; }
  const phases: RawPhase[] = [];
  const bulletRe = new RegExp(`^-\\s*\\*\\*${escapeRegExp(person)}\\*\\*`);
  const stripRe = new RegExp(`^[-*]\\s*\\*\\*${escapeRegExp(person)}\\*\\*\\s*[—–-]?\\s*`);

  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h];
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
    const heading = lines[start].replace(/^##\s+/, "").trim();
    if (!isTimePhased(heading)) continue;
    const { title, window } = splitTitleWindow(heading);

    let bullet = "";
    for (let i = start + 1; i < end; i++) {
      if (bulletRe.test(lines[i])) {
        const buf = [lines[i]];
        for (let j = i + 1; j < end; j++) {
          const nxt = lines[j];
          if (/^-\s/.test(nxt) || /^#/.test(nxt) || nxt.trim() === "") break; // stop at next bullet/heading/blank
          buf.push(nxt);
        }
        bullet = buf.join(" ").replace(/\s+/g, " ").trim().replace(stripRe, "");
        break;
      }
    }
    const issueRefs = [...new Set([...bullet.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
    phases.push({ title, window, start: phaseStartMs(title, window, today), bullet, issueRefs });
  }

  // current phase = the last whose start ≤ today; if no real dates anywhere, fall back to first.
  const todayMs = Date.parse(today);
  const hasRealDate = phases.some((p) => p.start !== -Infinity);
  let currentIndex = 0;
  if (hasRealDate) {
    let found = -1;
    phases.forEach((p, i) => { if (p.start <= todayMs) found = i; });
    currentIndex = found >= 0 ? found : 0;
  }

  const toPhase = (p: RawPhase): RoadmapPhase => ({ title: p.title, window: p.window, bullet: p.bullet, issueRefs: p.issueRefs });
  // from the current phase onward, keep only phases where this person actually has a bullet.
  const fromCurrent = phases.slice(currentIndex).filter((p) => p.bullet.length > 0);
  const workingNow = fromCurrent[0] ? toPhase(fromCurrent[0]) : null;
  const comingUp = fromCurrent.slice(1).map(toPhase);

  return { role, owns, workingNow, comingUp };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/dashboard-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRoadmapForPerson } from "../src/tools/dashboard";

const ROADMAP = `# Sapling Roadmap

## Team & Responsibilities

| Person     | Role          | Owns                                              |
| ---------- | ------------- | ------------------------------------------------- |
| **Jose**   | Frontend      | React app, chat UI, UX                            |
| **Andres** | Fullstack     | Cross-cutting glue, integration, releases         |

## Issue tracking — tags & ownership

Prose that is not time-phased and must be ignored.

## Now → Next 2 Weeks (through ~2026-06-21)

- **Andres** — P0 #124 (realtime chat ciphertext); start streaming chat #70.
- **Jose** — frontend audit P0s #102.

## Weeks 3–4 (~2026-06-22 → 2026-07-05)

- **Andres** — semesters API + GPA #138; document-pipeline robustness #132;
  integration testing across the migrated agents.
- **Jose** — semesters UI #139.

## July — Agent Migration

- **Andres** — decision record for the migration cutover; performance pass.

## August — Tutoring Depth

- **Jose** — interactive graph navigation.
`;

const TODAY = "2026-06-26";

describe("parseRoadmapForPerson", () => {
  it("extracts role/owns and the date-current phase, dropping past phases", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Andres", TODAY);
    expect(r.role).toBe("Fullstack");
    expect(r.owns).toBe("Cross-cutting glue, integration, releases");
    expect(r.workingNow?.title).toBe("Weeks 3–4");
    expect(r.workingNow?.window).toContain("2026-06-22");
    expect(r.workingNow?.bullet).toMatch(/^semesters API \+ GPA #138/);
    expect(r.workingNow?.issueRefs).toEqual([138, 132]);
  });

  it("skips phases where the person has no bullet (Andres has none in August)", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Andres", TODAY);
    expect(r.comingUp.map((p) => p.title)).toEqual(["July — Agent Migration"]);
  });

  it("skips intermediate no-bullet phases for another person (Jose skips July)", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Jose", TODAY);
    expect(r.workingNow?.title).toBe("Weeks 3–4");
    expect(r.comingUp.map((p) => p.title)).toEqual(["August — Tutoring Depth"]);
  });

  it("returns nulls/empties for an unmapped person", () => {
    const r = parseRoadmapForPerson(ROADMAP, "Nobody", TODAY);
    expect(r).toEqual({ role: null, owns: null, workingNow: null, comingUp: [] });
  });

  it("falls back to the first phase when no real dates parse", () => {
    const md = `## Now → Phase One

- **Andres** — first thing #1.

## Now → Phase Two

- **Andres** — second thing #2.
`;
    const r = parseRoadmapForPerson(md, "Andres", TODAY);
    expect(r.workingNow?.title).toBe("Now → Phase One");
    expect(r.comingUp.map((p) => p.title)).toEqual(["Now → Phase Two"]);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/dashboard-parse.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/dashboard.ts test/dashboard-parse.test.ts
git commit -m "feat(dashboard): parse roadmap now/next bullets per person" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: listAssignedIssues

**Files:**
- Modify: `src/tools/dashboard.ts`
- Test: `test/dashboard-issues.test.ts`

**Interfaces:**
- Consumes: `AssignedIssue` (Task 1).
- Produces: `listAssignedIssues(opts: { token: string; repo: string; login: string; fetchImpl?: typeof fetch }): Promise<AssignedIssue[]>`; module constants `GH_API`, `USER_AGENT`.

- [ ] **Step 1: Add the issue fetcher**

In `src/tools/dashboard.ts`, change the top import line to also bring in `AssignedIssue`:

```ts
import type { RoadmapPhase, AssignedIssue } from "@shared/dashboard";
```

Immediately below that import line, add the GitHub constants:

```ts
const GH_API = "application/vnd.github+json";
const USER_AGENT = "canopy";
```

Then append to the end of the file:

```ts
function priorityOf(title: string): "P0" | "P1" | "P2" | "P3" | null {
  const m = title.match(/^\s*\[(P[0-3])\]/);
  return m ? (m[1] as "P0" | "P1" | "P2" | "P3") : null;
}
function stripPriority(title: string): string {
  return title.replace(/^\s*\[P[0-3]\]\s*/, "").trim();
}

/** Open issues assigned to `login` in `repo`, fetched live. PRs are filtered out (the
 *  issues endpoint returns both). Never throws — returns [] on any non-OK/parse failure. */
export async function listAssignedIssues(opts: {
  token: string;
  repo: string;
  login: string;
  fetchImpl?: typeof fetch;
}): Promise<AssignedIssue[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, accept: GH_API, "user-agent": USER_AGENT };
  const url = `https://api.github.com/repos/${opts.repo}/issues?assignee=${encodeURIComponent(opts.login)}&state=open&per_page=50`;
  try {
    const res = await doFetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      updated_at: string;
      pull_request?: unknown;
      labels?: Array<{ name?: string } | string>;
    }>;
    return data
      .filter((it) => !it.pull_request)
      .map((it) => ({
        number: it.number,
        title: stripPriority(it.title),
        priority: priorityOf(it.title),
        labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
        url: it.html_url,
        updatedAt: it.updated_at,
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/dashboard-issues.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { listAssignedIssues } from "../src/tools/dashboard";

function stub(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("listAssignedIssues", () => {
  it("maps issues, parses priority + labels, and filters out PRs", async () => {
    const fetchImpl = stub([
      { number: 124, title: "[P0] realtime chat ciphertext", html_url: "https://github.com/o/r/issues/124", updated_at: "2026-06-20T00:00:00Z", labels: [{ name: "security" }, "backend"] },
      { number: 74, title: "[P1] SSE deltas", html_url: "https://github.com/o/r/issues/74", updated_at: "2026-06-19T00:00:00Z", labels: [] },
      { number: 9, title: "[P2] a pull request", html_url: "https://github.com/o/r/pull/9", updated_at: "x", pull_request: { url: "u" } },
      { number: 50, title: "no priority tag", html_url: "https://github.com/o/r/issues/50", updated_at: "2026-06-18T00:00:00Z" },
    ]);
    const issues = await listAssignedIssues({ token: "t", repo: "o/r", login: "andres", fetchImpl });
    expect(issues.map((i) => i.number)).toEqual([124, 74, 50]); // PR #9 filtered
    expect(issues[0]).toMatchObject({ number: 124, title: "realtime chat ciphertext", priority: "P0", labels: ["security", "backend"] });
    expect(issues[1].priority).toBe("P1");
    expect(issues[2].priority).toBeNull();
  });

  it("returns [] on a non-OK response (expired token), never throws", async () => {
    const issues = await listAssignedIssues({ token: "stale", repo: "o/r", login: "a", fetchImpl: stub({}, 401) });
    expect(issues).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/dashboard-issues.test.ts`
Expected: PASS (both cases).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/dashboard.ts test/dashboard-issues.test.ts
git commit -m "feat(dashboard): live-fetch assigned GitHub issues" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: getMyDashboard aggregator

**Files:**
- Modify: `src/tools/dashboard.ts`
- Test: `test/dashboard-aggregate.test.ts`

**Interfaces:**
- Consumes: `get_focus`, `get_feed` (reads.ts), `loginToPerson` (people.ts), `parseRoadmapForPerson`, `listAssignedIssues` (this file), `DashboardData`, `Focus` (Task 1).
- Produces: `fetchRoadmapMarkdown(opts: { token: string; repo: string; fetchImpl?: typeof fetch }): Promise<string | null>`; `getMyDashboard(opts: { db: DB; login: string; token: string | null; repo: string; today: string; fetchImpl?: typeof fetch }): Promise<DashboardData>`.

- [ ] **Step 1: Add the aggregator**

In `src/tools/dashboard.ts`, extend the top imports. Change the `@shared/dashboard` import to add `DashboardData` and `Focus`, and add the new imports below it:

```ts
import type { RoadmapPhase, AssignedIssue, DashboardData, Focus } from "@shared/dashboard";
import type { DB } from "../db";
import { get_focus, get_feed } from "./reads";
import { loginToPerson } from "../people";
```

Then append to the end of the file:

```ts
/** Fetch ROADMAP.md raw from `repo`. Never throws — returns null on any failure. */
export async function fetchRoadmapMarkdown(opts: {
  token: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${opts.repo}/contents/ROADMAP.md`, {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github.raw", "user-agent": USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Assemble the personal dashboard. D1 data (focus, feed) is always returned; the
 *  GitHub-derived roadmap/issues are returned when the token works, else degraded. */
export async function getMyDashboard(opts: {
  db: DB;
  login: string;
  token: string | null;
  repo: string;
  today: string;
  fetchImpl?: typeof fetch;
}): Promise<DashboardData> {
  const { db, login, token, repo, today, fetchImpl } = opts;

  const focusRow = await get_focus(db, login);
  const focus: Focus | null = focusRow
    ? { workingOn: focusRow.working_on, nextUp: focusRow.next_up, updatedAt: focusRow.updated_at }
    : null;
  const feed = await get_feed(db, { author: login, limit: 8 });
  const person = loginToPerson(login);

  let role: string | null = null;
  let owns: string | null = null;
  let workingNow: RoadmapPhase | null = null;
  let comingUp: RoadmapPhase[] = [];
  let assignedIssues: AssignedIssue[] = [];
  let degraded = false;

  if (!token) {
    degraded = true;
  } else {
    const [md, issues] = await Promise.all([
      person ? fetchRoadmapMarkdown({ token, repo, fetchImpl }) : Promise.resolve(null),
      listAssignedIssues({ token, repo, login, fetchImpl }),
    ]);
    assignedIssues = issues;
    if (person && md) {
      const parsed = parseRoadmapForPerson(md, person, today);
      role = parsed.role;
      owns = parsed.owns;
      workingNow = parsed.workingNow;
      comingUp = parsed.comingUp;
    } else if (person && !md) {
      degraded = true; // had a token + a mapped person, but the roadmap read failed
    }
  }

  return { person, role, owns, focus, workingNow, comingUp, assignedIssues, feed, degraded };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/dashboard-aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getMyDashboard } from "../src/tools/dashboard";
import { ingestFocusUpdate } from "../src/consumer";
import { append_feed } from "../src/tools/writes";

const ROADMAP = `# Sapling Roadmap

## Team & Responsibilities

| Person     | Role      | Owns                          |
| ---------- | --------- | ----------------------------- |
| **Andres** | Fullstack | Integration, releases         |

## Weeks 3–4 (~2026-06-22 → 2026-07-05)

- **Andres** — semesters API + GPA #138.

## July — Agent Migration

- **Andres** — migration decision record.
`;

const ISSUES = [
  { number: 138, title: "[P1] semesters API", html_url: "https://github.com/o/r/issues/138", updated_at: "2026-06-25T00:00:00Z", labels: [{ name: "backend" }] },
];

function stubGh(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contents/ROADMAP.md")) return new Response(ROADMAP, { status: 200 });
    if (u.includes("/issues?assignee=")) return new Response(JSON.stringify(ISSUES), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("getMyDashboard", () => {
  it("assembles focus + feed + parsed roadmap + assigned issues", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "wire My Work #999", next_up: "polish" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "landed the route", artifacts: { prs: [], commits: [], issues: [] } });

    const d = await getMyDashboard({
      db: env.DB, login: "AndresL230", token: "t", repo: "o/r", today: "2026-06-26", fetchImpl: stubGh(),
    });

    expect(d.person).toBe("Andres");
    expect(d.role).toBe("Fullstack");
    expect(d.focus).toMatchObject({ workingOn: "wire My Work #999", nextUp: "polish" });
    expect(d.workingNow?.title).toBe("Weeks 3–4");
    expect(d.comingUp.map((p) => p.title)).toEqual(["July — Agent Migration"]);
    expect(d.assignedIssues.map((i) => i.number)).toEqual([138]);
    expect(d.feed).toHaveLength(1);
    expect(d.degraded).toBe(false);
  });

  it("degrades without a token: focus + feed still returned, roadmap/issues empty, no throw", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "x" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "y", artifacts: { prs: [], commits: [], issues: [] } });

    const d = await getMyDashboard({
      db: env.DB, login: "AndresL230", token: null, repo: "o/r", today: "2026-06-26",
    });

    expect(d.degraded).toBe(true);
    expect(d.focus?.workingOn).toBe("x");
    expect(d.feed).toHaveLength(1);
    expect(d.workingNow).toBeNull();
    expect(d.comingUp).toEqual([]);
    expect(d.assignedIssues).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/dashboard-aggregate.test.ts`
Expected: PASS (both cases).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/dashboard.ts test/dashboard-aggregate.test.ts
git commit -m "feat(dashboard): aggregate focus, roadmap, issues, feed" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: GET /me/dashboard route + CONTENT_REPO

**Files:**
- Modify: `src/env.ts`, `wrangler.toml`, `src/routes.ts`
- Test: `test/dashboard-route.test.ts`

**Interfaces:**
- Consumes: `getMyDashboard` (Task 6), `getStoredToken` (existing), `nowIso` (existing).
- Produces: HTTP `GET /me/dashboard` returning `DashboardData` JSON (session-gated).

- [ ] **Step 1: Add the env var type**

In `src/env.ts`, add a field to the `Env` interface (after `GITHUB_REPO`):

```ts
  CONTENT_REPO?: string;  // "owner/repo" the dashboard reads (ROADMAP.md + assigned issues); defaults to SaplingLearn/sapling
```

- [ ] **Step 2: Add the wrangler var**

In `wrangler.toml`, under the `[vars]` table (next to `GITHUB_REPO`), add:

```toml
CONTENT_REPO = "SaplingLearn/sapling"
```

- [ ] **Step 3: Add the route**

In `src/routes.ts`, add two imports near the existing tool imports (after the `list_roadmap` import line):

```ts
import { getMyDashboard } from "./tools/dashboard";
import { nowIso } from "./db";
```

Then add the route (after the `GET /roadmap` handler, before the milestone-proposals promote route):

```ts
// Personal dashboard (session-gated): the signed-in user's focus, roadmap assignments,
// assigned issues, and recent feed — assembled live, stored nowhere. Never 500s.
app.get("/me/dashboard", async (c) => {
  const login = c.get("principal").login;
  const token = await getStoredToken(c.env.DB, login, c.env.COOKIE_SECRET);
  const data = await getMyDashboard({
    db: c.env.DB,
    login,
    token,
    repo: c.env.CONTENT_REPO ?? "SaplingLearn/sapling",
    today: nowIso(),
  });
  return c.json(data);
});
```

- [ ] **Step 4: Write the failing test**

Create `test/dashboard-route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestFocusUpdate } from "../src/consumer";
import { append_feed } from "../src/tools/writes";

async function cookieFor(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("GET /me/dashboard (session-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/me/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns focus + feed for the principal (no GitHub token in test env → degraded)", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "wire My Work" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "landed route", artifacts: { prs: [], commits: [], issues: [] } });

    const res = await app.request("/me/dashboard", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      person: string | null; focus: { workingOn: string } | null;
      feed: unknown[]; degraded: boolean; workingNow: unknown; assignedIssues: unknown[];
    };
    expect(body.person).toBe("Andres");          // login mapped server-side
    expect(body.focus?.workingOn).toBe("wire My Work");
    expect(body.feed).toHaveLength(1);
    expect(body.degraded).toBe(true);            // no stored github_token for this user
    expect(body.workingNow).toBeNull();
    expect(body.assignedIssues).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/dashboard-route.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test`
Expected: all tests pass.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/env.ts wrangler.toml src/routes.ts test/dashboard-route.test.ts
git commit -m "feat(routes): add GET /me/dashboard and CONTENT_REPO var" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Web — the "My Work" screen

**Files:**
- Modify: `web/src/api.ts`, `web/src/render.ts`, `web/src/main.ts`, `web/src/canopy.css`, `scripts/seed-dev.sql`

**Interfaces:**
- Consumes: `DashboardData`, `RoadmapPhase` (`@shared/dashboard`); existing render helpers `esc`, `attr`, `relTime`, `linkifyRefs`, `notice`, `REPO_URL`.
- Produces: web screen `"mywork"` (default landing), loader `loadMyWork`, dispatch `goMyWork`.

(No Vitest — the web is a static build verified by `npm run typecheck` + `npm run build:web`.)

- [ ] **Step 1: Add the API call**

In `web/src/api.ts`, add an import near the top (after the `@shared/rows` import block):

```ts
import type { DashboardData } from "@shared/dashboard";
```

Add the fetch function in the reads section (after `getMe`):

```ts
export function getMyDashboard(): Promise<DashboardData> {
  return getJson<DashboardData>("/me/dashboard");
}
```

And re-export the type at the bottom (extend the existing re-export line or add):

```ts
export type { DashboardData };
```

- [ ] **Step 2: Wire types, Screen, state, and nav into render.ts**

In `web/src/render.ts`:

(a) Add an import after line 9 (`import type { AdrRow, NeedsTriageRow } from "@shared/rows";`):

```ts
import type { DashboardData, RoadmapPhase } from "@shared/dashboard";
```

(b) Change the `Screen` type (line 16) to include `"mywork"`:

```ts
export type Screen = "mywork" | "feed" | "docs" | "roadmap" | "triage" | "search" | "settings" | "guide";
```

(c) In `AppState` (after the `me: Me | null;` line), add:

```ts
  mywork: Loadable<DashboardData | null>;
```

(d) In `initialState()`, change `screen: "feed",` to `screen: "mywork",` and add a slice (next to the other loadables):

```ts
    mywork: { status: "idle", data: null },
```

(e) In `sidebar()`, add the nav item as the FIRST entry in the `<nav>` (immediately before the existing `goRoadmap` item):

```ts
      ${navItem("goMyWork", "n-mywork", "My Work", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M3 12 12 3l9 9"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path></svg>`)}
```

(f) In `header()`, add `mywork: "My Work"` to the `titles` record (first key):

```ts
  const titles: Record<Screen, string> = { mywork: "My Work", feed: "Feed", docs: "Docs", roadmap: "Roadmap", triage: "Triage", search: "Search", settings: "Settings", guide: "Get Started" };
```

(g) In `screenBody()`, add a case (first, before `feed`):

```ts
    case "mywork": return myWorkView(s);
```

- [ ] **Step 3: Add the myWorkView and its helpers**

In `web/src/render.ts`, add this block immediately before the `// ── root ───` comment (just before `function screenBody`):

```ts
// ── my work (personal dashboard) ──────────────────────────────────────────────
const MW_LABEL = "font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)";

function wrapMyWork(inner: string): string {
  return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 32px 100px">${inner}</div>`;
}
function greetingFor(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
function mwSection(label: string, body: string): string {
  return `<section style="margin-top:26px"><div style="${MW_LABEL};margin-bottom:12px">${label}</div>${body}</section>`;
}
function mwRoadmapRow(label: string, p: RoadmapPhase): string {
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px">
      <span style="font-size:12.5px;font-weight:600;color:var(--fg-70)">${esc(label)}</span>
      ${p.window ? `<span style="font-size:11px;color:var(--fg-40)">${esc(p.window)}</span>` : ""}
    </div>
    <div style="font-size:13px;line-height:1.55;color:var(--fg-55)">${linkifyRefs(p.bullet)}</div>
  </div>`;
}

function myWorkView(s: AppState): string {
  const slice = s.mywork;
  if (slice.status === "loading" && !slice.data) return wrapMyWork(notice("Loading your work&hellip;"));
  if (slice.status === "error") return wrapMyWork(notice("Couldn't load your dashboard."));
  const d = slice.data;
  if (!d) return wrapMyWork(notice("Nothing to show yet."));

  const name = esc(s.displayName || s.me?.name || s.me?.login || "there");
  const subParts: string[] = [];
  if (d.role) subParts.push(`<span style="color:var(--fg-70);font-weight:500">${esc(d.role)}</span>`);
  if (d.owns) subParts.push(`owns ${esc(d.owns)}`);
  const header = `<div style="margin-bottom:24px">
    <h2 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0">${greetingFor()}, ${name}</h2>
    ${subParts.length ? `<div style="font-size:13px;color:var(--fg-55);margin-top:5px">${subParts.join(" · ")}</div>` : ""}
  </div>`;

  // headline: focus (preferred) → roadmap "now" (fallback) → empty hint
  let headline: string;
  if (d.focus) {
    headline = `<div style="border:1px solid var(--accent);background:var(--accent-soft);border-radius:13px;padding:18px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px">
        <span style="${MW_LABEL};color:var(--accent)">Working on now</span>
        <span style="font-size:11.5px;color:var(--fg-40)">updated ${relTime(d.focus.updatedAt)}</span>
      </div>
      <div style="font-size:15px;line-height:1.6;color:var(--fg)">${linkifyRefs(d.focus.workingOn)}</div>
      ${d.focus.nextUp ? `<div style="margin-top:14px"><div style="${MW_LABEL};margin-bottom:6px">Next up</div><div style="font-size:14px;line-height:1.6;color:var(--fg-70)">${linkifyRefs(d.focus.nextUp)}</div></div>` : ""}
    </div>`;
  } else if (d.workingNow) {
    headline = `<div style="border:1px solid var(--border-strong);border-radius:13px;padding:18px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px">
        <span style="${MW_LABEL}">Working on now</span>
        <span style="font-size:11.5px;color:var(--fg-40)">${esc(d.workingNow.title)}${d.workingNow.window ? ` · ${esc(d.workingNow.window)}` : ""}</span>
      </div>
      <div style="font-size:15px;line-height:1.6;color:var(--fg)">${linkifyRefs(d.workingNow.bullet)}</div>
    </div>`;
  } else {
    headline = `<div style="border:1px dashed var(--border-strong);border-radius:13px;padding:18px 20px;color:var(--fg-55);font-size:13.5px;line-height:1.6">No focus set yet. Ask your coding agent to &ldquo;record this session&rdquo; to set what you're working on.</div>`;
  }

  // roadmap context below the focus headline (or upcoming list when roadmap is the headline)
  const rows: string[] = [];
  if (d.focus && d.workingNow) rows.push(mwRoadmapRow(d.workingNow.title, d.workingNow));
  for (const p of d.comingUp) rows.push(mwRoadmapRow(p.title, p));
  const roadmap = rows.length ? mwSection("From the roadmap", `<div style="display:flex;flex-direction:column;gap:10px">${rows.join("")}</div>`) : "";

  // assigned issues
  let issues: string;
  if (d.degraded) {
    issues = mwSection("Assigned to you", `<div style="font-size:13px;color:var(--fg-40);padding:2px 0">Connect GitHub to see issues assigned to you.</div>`);
  } else if (d.assignedIssues.length === 0) {
    issues = mwSection("Assigned to you", `<div style="font-size:13px;color:var(--fg-40);padding:2px 0">No open issues assigned to you.</div>`);
  } else {
    const list = d.assignedIssues.map((it) => {
      const pr = it.priority ? `<span style="font-size:10.5px;font-weight:700;font-family:var(--mono);color:var(--amber);flex:none">${esc(it.priority)}</span>` : "";
      const labels = it.labels.slice(0, 3).map((l) => `<span style="font-size:10.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px">${esc(l)}</span>`).join("");
      return `<a href="${attr(it.url)}" target="_blank" rel="noopener" class="cnpy-card" style="display:flex;align-items:center;gap:11px;border:1px solid var(--border);border-radius:10px;padding:11px 14px;text-decoration:none;color:var(--fg)">
        ${pr}
        <span style="font-family:var(--mono);font-size:12px;color:var(--fg-40);flex:none">#${it.number}</span>
        <span style="flex:1;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title)}</span>
        <span style="display:flex;gap:5px;flex:none">${labels}</span>
      </a>`;
    }).join("");
    issues = mwSection(`Assigned to you <span style="color:var(--fg-40);font-weight:400">· ${d.assignedIssues.length} open</span>`, `<div style="display:flex;flex-direction:column;gap:8px">${list}</div>`);
  }

  // recent activity (feed)
  let activity: string;
  if (d.feed.length === 0) {
    activity = mwSection("Your recent activity", `<div style="font-size:13px;color:var(--fg-40);padding:2px 0">No feed entries yet.</div>`);
  } else {
    const items = d.feed.map((e) => `<div style="display:flex;gap:11px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0;font-size:13.5px;line-height:1.5">${linkifyRefs(e.summary)}</div>
      <span style="font-size:11.5px;color:var(--fg-40);flex:none;white-space:nowrap">${relTime(e.created_at)}</span>
    </div>`).join("");
    activity = mwSection("Your recent activity", items);
  }

  return wrapMyWork(`${header}${headline}${roadmap}${issues}${activity}`);
}
```

- [ ] **Step 4: Add the nav-active CSS rule**

In `web/src/canopy.css`, line 31 lists the active-nav selectors. Add the `mywork` selector to that comma list (at the front):

```css
[data-screen="mywork"] .cnpy-nav.n-mywork, [data-screen="feed"] .cnpy-nav.n-feed, [data-screen="docs"] .cnpy-nav.n-docs, [data-screen="roadmap"] .cnpy-nav.n-roadmap, [data-screen="triage"] .cnpy-nav.n-triage, [data-screen="search"] .cnpy-nav.n-search { background:var(--accent-soft); color:var(--accent); }
```

- [ ] **Step 5: Wire the loader, dispatch, and boot in main.ts**

In `web/src/main.ts`:

(a) Add `getMyDashboard` to the `./api` import list (line 8-14 block):

```ts
  getFeed, listDocs, getDoc, search, getRoadmap, getMyDashboard,
```

(b) Add the loader (next to `loadFeed`, e.g. after `loadFeedIfNeeded`):

```ts
function loadMyWork(): void {
  state.mywork = { status: "loading", data: state.mywork.data };
  rerender();
  getMyDashboard()
    .then((data) => {
      state.mywork = { status: "ok", data };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.mywork = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadMyWorkIfNeeded(): void {
  if (state.mywork.status === "idle") loadMyWork();
  else rerender();
}
```

(c) Add the dispatch case (in the "primary navigation" group, before `goFeed`):

```ts
    case "goMyWork": state.screen = "mywork"; loadMyWorkIfNeeded(); return;
```

(d) Change the boot path: in the `getMe().then(...)` block, replace `loadFeed();` with `loadMyWork();`:

```ts
      state.view = "app";
      loadMyWork();
```

- [ ] **Step 6: Seed the dev preview**

In `scripts/seed-dev.sql`, after the `INSERT INTO feed (...)` block (after line ~37), add:

```sql
-- Personal "My Work" preview for DEV_LOGIN=devuser. No GitHub token in dev, so the
-- roadmap + assigned-issues sections degrade; focus + feed render from D1.
INSERT INTO focus (author, working_on, next_up, updated_at) VALUES
  ('devuser','Wiring the personal “My Work” dashboard — focus headline, assigned issues, recent activity. #142','Promote-flow polish, then the record-session focus capture.','2026-06-26T09:00:00Z');
INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES
  ('devuser','Scaffolded the My Work dashboard route and view',NULL,'{"prs":[],"commits":[],"issues":[]}','2026-06-26T09:05:00Z'),
  ('devuser','Added set_focus MCP tool through the gate',NULL,'{"prs":[],"commits":[],"issues":[]}','2026-06-25T17:00:00Z');
```

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors (worker + web).
Run: `npm run build:web`
Expected: build succeeds, no errors.

- [ ] **Step 8: (Optional) Visual check**

Run `npm run dev`, sign in via the dev path (`DEV_LOGIN=devuser`), and confirm the app lands on **My Work** with the greeting, the focus headline, the degraded notices for roadmap/issues, and the seeded recent activity. (`scripts/dev-shot.mjs` can capture a screenshot if preferred.)

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/render.ts web/src/main.ts web/src/canopy.css scripts/seed-dev.sql
git commit -m "feat(web): add My Work personal dashboard as the default screen" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Extend record-session to capture focus

**Files:**
- Modify: `.claude/skills/record-session/SKILL.md`

**Interfaces:**
- Consumes: the `set_focus` MCP tool (Task 2).

- [ ] **Step 1: Allow the tool**

In `.claude/skills/record-session/SKILL.md`, the `allowed-tools:` frontmatter line ends with `mcp__canopy__propose_doc_update`. Append `, mcp__canopy__set_focus` so it reads:

```
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), mcp__canopy__append_feed, mcp__canopy__get_feed, mcp__canopy__propose_doc_update, mcp__canopy__set_focus
```

- [ ] **Step 2: Add the focus-capture step**

In `.claude/skills/record-session/SKILL.md`, after the `### 4. Write surface — reach for, in order` section (immediately before the `## Vocabulary` heading), insert:

```markdown
### 5. Update your focus (the personal dashboard headline)

After the feed entry is written, set the person's **current focus** so their "My Work"
dashboard reflects this session:

- `working_on` — a one-line summary of what this session actually advanced (the same
  factual thrust as the feed entry; prose intent is fine here).
- `next_up` — the clearly-stated next step, if there is one (omit if there isn't).

Call `set_focus` **once** per explicit wrap-up request, alongside the feed entry. Focus is
forward-looking prose (intent), so it is exempt from the "artifacts are observed" rule —
that rule still binds the feed entry's artifacts. `set_focus` upserts one row per person
(it overwrites your previous focus); the author is resolved from your bearer, never sent.
```

- [ ] **Step 3: Verify the edit**

Run: `head -6 .claude/skills/record-session/SKILL.md` and confirm `mcp__canopy__set_focus` is in `allowed-tools`. Confirm the new `### 5.` section is present and the `## Vocabulary` heading still follows it.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/record-session/SKILL.md
git commit -m "feat(record-session): capture focus for the dashboard at session end" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — all tests pass.
- [ ] Run `npm run typecheck` — no errors.
- [ ] Run `npm run build:web` — build succeeds.

---

## Self-Review

**Spec coverage:**
- Focus status source → Tasks 1, 2 (table/gate/tool), 6 (read into payload), 8 (headline). ✓
- Roadmap assignments parsed from sapling ROADMAP.md → Task 4 (parse), 6 (fetch+merge), 7 (CONTENT_REPO). ✓
- Live assigned GitHub issues → Task 5, merged in Task 6. ✓
- Recent feed activity → Task 6 (`get_feed` author+limit), Task 8 (render). ✓
- Identity mapping (hardcoded) → Task 3. ✓
- Single aggregation endpoint, token server-side, never 500 → Tasks 6, 7. ✓
- Graceful degradation (focus+feed survive) → Tasks 6, 7, 8. ✓
- New "My Work" screen, default landing, top of nav → Task 8. ✓
- Session-end write via record-session, gated, not human-confirmed, no second write surface → Tasks 2, 9. ✓
- Tests on real Miniflare D1, GitHub I/O injected → Tasks 2,4,5,6,7. ✓
- `focus` added to test truncation → Task 2 Step 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows full test bodies. ✓

**Type consistency:** `DashboardData`/`RoadmapPhase`/`AssignedIssue`/`Focus` defined in Task 1 and used identically in Tasks 6/7/8. `set_focus(db,{author,working_on,next_up?})`, `get_focus(db,author)`, `ingestFocusUpdate(db,update,author)`, `getMyDashboard({db,login,token,repo,today,fetchImpl?})`, `listAssignedIssues({token,repo,login,fetchImpl?})`, `fetchRoadmapMarkdown({token,repo,fetchImpl?})`, `parseRoadmapForPerson(markdown,person,today)`, `loginToPerson(login)` — signatures match across producing and consuming tasks. ✓
```
