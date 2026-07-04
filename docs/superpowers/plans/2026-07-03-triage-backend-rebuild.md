# Triage Backend Rebuild (Identity Queue + People Write Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the triage backend's new Maintenance surface — a dedicated `identity_tasks` queue raised by `ingestEvent` for unknown GitHub logins, plus the `people` table's first runtime write path (the map-to-person resolve) — per `canopy-build-triage.md`.

**Architecture:** The Review group (Proposals/Decisions routes + resolves) and the Unplaced-items behavior are **unchanged** — this plan only verifies them. The new work is one migration (`identity_tasks`), an intake hook in `ingestEvent` that runs AFTER the event write (capture never depends on it), a read that returns pending tasks each with a small live activity sample pulled from `events` at read time, and two cookie-gated routes (`GET /identity-tasks`, `POST /identity-tasks/:login/map`). Mapping is retroactive for free: My Work resolves login→person at read time (`src/tools/mywork.ts:61`), so one `people` row surfaces all already-captured events with no backfill.

**Tech Stack:** Cloudflare Worker (Hono), D1 (SQLite), Vitest + Miniflare (`cloudflare:test`), TypeScript, Zod (untouched here).

## Global Constraints

- Triage is human-only and cookie-gated: the new identity routes go on the Hono `app` in `src/routes.ts` (behind the global `sessionGate` at `src/routes.ts:18`). **No MCP tool reads or writes any triage queue** — do not touch `src/mcp.ts`.
- Event capture NEVER depends on identity intake: the identity task is raised only after the `events` INSERT in `ingestEvent`. A test must assert the event row exists even when the login is unknown.
- `people` is written at runtime ONLY by the identity resolve (`map_identity`). The `0012` seed stays the initial map. Nothing else writes `people`.
- Soft resolves only: `identity_tasks` rows flip `status='resolved'` with `resolved_at`/`resolved_by`; nothing hard-deletes.
- OUT OF SCOPE (do not implement): all frontend; feed three-set tag validation and skill/MCP edits (owned by `canopy-build-feed-triage.md` — `ingestFeedEntry` still calls `route_triage` at `src/consumer.ts:102` today and that stays until that spec lands); the milestones-queue teardown (`list_milestone_proposals`, `/milestone-proposals` routes, the assign milestone arm, the `milestone_proposals` table — rides the Phase 2 pass); a resolved-item history view.
- Review-group routes and resolves (`GET /proposals`, `GET /adrs`, promote/ratify/reject) are unchanged. Unplaced-items assign/discard behavior is unchanged.
- Tests run against real Miniflare D1. `vitest.config.ts` loads ALL of `migrations/` via `readD1Migrations`, so a new migration file is auto-applied — but the new table MUST be added to the truncation list in `test/apply-migrations.ts`. Never hit the network in tests.
- `npm test` does NOT run `tsc` — run `npm run typecheck` separately whenever types change.
- Commit messages follow the repo's conventional style (`feat(...)`, `fix(...)`, `test(...)`) and end with the trailer shown in each commit step.

---

### Task 1: `identity_tasks` migration, row type, and test-harness registration

The dedicated store (spec: "a dedicated `identity_tasks` table (login, first_seen, status, resolved/resolved_at/resolved_by), not a typed `needs_triage` row"). `login` is the PRIMARY KEY so many events from one unknown person collapse into one task via `INSERT OR IGNORE`, and a resolved task is never re-raised. Because `people` gains a runtime write path in Task 3, the test harness must start resetting it per test (today it is NOT in the truncation list, so runtime writes would leak across tests) — reseed the `0012` rows so existing My Work tests stay green.

**Files:**
- Create: `migrations/0016_identity_tasks.sql`
- Modify: `shared/rows.ts` (append after `PersonRow`, ~line 173)
- Modify: `test/apply-migrations.ts:16` (the truncation exec string)
- Test: `test/identity-schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `identity_tasks` table (columns: `login TEXT PK`, `first_seen TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'pending'`, `resolved_at TEXT`, `resolved_by TEXT`); `IdentityTaskRow { login: string; first_seen: string; status: "pending" | "resolved"; resolved_at: string | null; resolved_by: string | null }` exported from `@shared/rows`. Tasks 2–4 rely on both.

- [ ] **Step 1: Write the failing test**

Create `test/identity-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";

describe("identity_tasks schema (0016)", () => {
  it("stores one task per login with pending status and null audit columns", async () => {
    await run(
      env.DB,
      `INSERT INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`,
      "mystery-dev",
      "2026-07-01T10:00:00Z"
    );
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = ?`, "mystery-dev");
    expect(row).toMatchObject({
      login: "mystery-dev",
      first_seen: "2026-07-01T10:00:00Z",
      status: "pending",
      resolved_at: null,
      resolved_by: null,
    });
  });

  it("login is the PK: INSERT OR IGNORE collapses a second task for the same login", async () => {
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-01T10:00:00Z', 'pending')`);
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-02T10:00:00Z', 'pending')`);
    const rows = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'dup'`);
    expect(rows.length).toBe(1);
    expect(rows[0].first_seen).toBe("2026-07-01T10:00:00Z"); // the first sighting wins
  });

  // Sequential within this file: this test dirties people; the next asserts the
  // harness reset restored the 0012 seed. Guards Task 3's runtime writes from
  // leaking across tests.
  it("dirties the people map (setup for the reseed assertion below)", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('leaky-login', 'Leak')`);
    expect((await all<PersonRow>(env.DB, `SELECT * FROM people`)).length).toBe(5);
  });

  it("beforeEach resets people back to exactly the 0012 seed", async () => {
    const people = await all<PersonRow>(env.DB, `SELECT * FROM people ORDER BY login`);
    expect(people.length).toBe(4);
    expect(people.map((p) => p.login).sort()).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch"].sort()
    );
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'leaky-login'`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/identity-schema.test.ts`
Expected: FAIL — `no such table: identity_tasks` (and the reseed test fails because `people` has 5 rows).

- [ ] **Step 3: Create the migration**

Create `migrations/0016_identity_tasks.sql`:

```sql
-- Identity triage (Maintenance group): one pending task per unknown GitHub login
-- seen on a captured event. Raised by ingestEvent AFTER the event row lands, so
-- capture never depends on the task. Resolved by the human map-to-person route,
-- which performs the `people` table's only runtime write. login is the PK: many
-- events from one unknown person collapse into one task (INSERT OR IGNORE), and
-- a resolved task is never re-raised. Soft resolve only — rows are never deleted.
CREATE TABLE identity_tasks (
  login TEXT PRIMARY KEY,                   -- the unmapped GitHub login
  first_seen TEXT NOT NULL,                 -- ISO8601 of the first event that raised it
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'resolved'
  resolved_at TEXT,                         -- ISO8601 when mapped
  resolved_by TEXT                          -- the authenticated principal who mapped it
);
```

- [ ] **Step 4: Add `IdentityTaskRow` to `shared/rows.ts`**

Append directly after the `PersonRow` interface (after line 173):

```ts
// Identity triage task (0016): one pending row per unknown GitHub login seen on
// a captured event. Raised by ingestEvent after the event write; resolved by the
// map-to-person route (the `people` table's only runtime writer). Soft resolve.
export interface IdentityTaskRow {
  login: string;
  first_seen: string;
  status: "pending" | "resolved";
  resolved_at: string | null;
  resolved_by: string | null;
}
```

- [ ] **Step 5: Register the table in `test/apply-migrations.ts`**

Replace the exec string at line 13–17 so it (a) truncates `identity_tasks`, and (b) resets `people` to the `0012` seed — `people` is user-writable from Task 3 onward:

```ts
  await env.DB.exec(
    // pr_summaries.semantic_key REFERENCES events(semantic_key) — delete the
    // child before its parent, or the FK constraint rejects the parent delete.
    // people gains a runtime write path (identity resolve), so it is reset to
    // the 0012 seed each test rather than left to accumulate mappings.
    "DELETE FROM processed_items; DELETE FROM pr_summaries; DELETE FROM events; DELETE FROM milestone_progress; DELETE FROM plan_versions; UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL; DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM identity_tasks; DELETE FROM people; INSERT INTO people (login, person) VALUES ('AndresL230', 'Andres'), ('Jose-Gael-Cruz-Lopez', 'Jose'), ('lpcooper-arch', 'Luke'), ('Darkest-Teddy', 'Jack'); DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
  );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/identity-schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the FULL suite + typecheck (the harness change touches every test)**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green, no type errors. If any My Work / dashboard test fails on missing people rows, the reseed INSERT in Step 5 has a typo — the four rows must match `migrations/0012_events_plan.sql:49-53` exactly.

- [ ] **Step 8: Commit**

```bash
git add migrations/0016_identity_tasks.sql shared/rows.ts test/apply-migrations.ts test/identity-schema.test.ts
git commit -m "feat(triage): identity_tasks store for unknown-login triage (0016)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `ensure_identity_task` writer + `ingestEvent` intake

The intake hook (spec: "in `ingestEvent`, after the event row is written, if `subject_login` is not in `people`, upsert one pending identity task keyed by login"). It runs after the `events` INSERT **on every call, including `unchanged` dedupe hits**, so events captured before this feature existed still raise a task on their next redelivery/backfill overlap; `INSERT OR IGNORE` on the PK makes that idempotent. Both `ingestEvent` call sites (`src/webhook.ts:295`, `src/tools/backfill.ts:181,214`) get the intake for free.

**Files:**
- Modify: `src/tools/writes.ts` (imports at line 1; new function after `route_triage`, ~line 150)
- Modify: `src/consumer.ts` (import at line 9; `ingestEvent` body at lines 265-277)
- Test: `test/identity-intake.test.ts`

**Interfaces:**
- Consumes: `identity_tasks` table + `IdentityTaskRow` (Task 1).
- Produces: `ensure_identity_task(db: DB, login: string): Promise<void>` exported from `src/tools/writes.ts` (checks `people`, then `INSERT OR IGNORE` a pending task); `ingestEvent` now raises identity tasks as a side effect. Task 4's tests rely on ingesting events creating tasks.

- [ ] **Step 1: Write the failing test**

Create `test/identity-intake.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import { ingestEvent } from "../src/consumer";
import type { EventRow, IdentityTaskRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged",
  event_type: "pr_merged",
  ref_number: 7,
  subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "Fix the flux capacitor", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("ingestEvent identity intake", () => {
  // The spec-mandated assertion: the event lands whether or not the task is raised.
  it("captures the event AND raises one pending identity task for an unknown login", async () => {
    const res = await ingestEvent(env.DB, ev(), "github-webhook");
    expect(res.outcome).toBe("written");

    // The event row exists even though the login is unknown.
    const events = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(events.length).toBe(1);
    expect(events[0].subject_login).toBe("mystery-dev");

    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task).toMatchObject({ login: "mystery-dev", status: "pending", resolved_at: null, resolved_by: null });
    expect(task!.first_seen).toBeTruthy();
  });

  it("many events from one unknown person make one task", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");
    await ingestEvent(env.DB, ev({ semantic_key: "gh:pr:8:merged", ref_number: 8 }), "github-webhook");
    await ingestEvent(env.DB, ev({ semantic_key: "gh:issue:9:closed:2026-07-01T10:00:00Z", event_type: "issue", ref_number: 9 }), "github-webhook");
    const tasks = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks`);
    expect(tasks.length).toBe(1);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(3);
  });

  it("a mapped login (0012 seed) raises nothing", async () => {
    await ingestEvent(env.DB, ev({ subject_login: "AndresL230" }), "github-webhook");
    expect((await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks`)).length).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1); // event still captured
  });

  it("an unchanged redelivery still leaves exactly one task (intake runs on dedupe hits too)", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");
    await run(env.DB, `DELETE FROM identity_tasks`); // simulate an event captured before the feature existed
    const res = await ingestEvent(env.DB, ev(), "github-webhook");
    expect(res.outcome).toBe("unchanged");
    expect((await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`)).length).toBe(1);
  });

  it("a resolved task is never re-raised by later events (PK guard)", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");
    await run(env.DB, `UPDATE identity_tasks SET status = 'resolved', resolved_at = '2026-07-02T00:00:00Z', resolved_by = 'andres' WHERE login = 'mystery-dev'`);
    await ingestEvent(env.DB, ev({ semantic_key: "gh:pr:99:merged", ref_number: 99 }), "github-webhook");
    const tasks = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("resolved"); // untouched, not flipped back to pending
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/identity-intake.test.ts`
Expected: FAIL — events are captured but `identity_tasks` stays empty (no intake exists yet).

- [ ] **Step 3: Add `ensure_identity_task` to `src/tools/writes.ts`**

First extend the type import at line 1:

```ts
import type { DocRow, DocVersionRow, AdrRow, MilestoneRow, MilestoneProposalRow, NeedsTriageRow, PersonRow, IdentityTaskRow } from "@shared/rows";
```

(`IdentityTaskRow` is used by Task 3's `map_identity`; adding it now is harmless — if `tsc` flags it unused, add it in Task 3 instead.)

Then add after `route_triage` (after line 150):

```ts
/**
 * Identity intake (Maintenance group): ensure one pending identity task exists
 * for an unmapped GitHub login. Called by ingestEvent AFTER the event row lands,
 * so capture never depends on this. login is the PK — INSERT OR IGNORE collapses
 * many events from one unknown person into one task and never re-raises a
 * resolved one. A login already in `people` raises nothing.
 */
export async function ensure_identity_task(db: DB, login: string): Promise<void> {
  const known = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
  if (known) return;
  await run(
    db,
    `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`,
    login,
    nowIso()
  );
}
```

- [ ] **Step 4: Hook it into `ingestEvent` in `src/consumer.ts`**

Extend the import at line 9:

```ts
import { append_feed, propose_doc_update, stage_adr, route_triage, stage_milestone_proposal, ensure_identity_task } from "./tools/writes";
```

(This is inside the deliberate writes.ts ↔ consumer.ts circular import — safe because the reference is inside a function body, same as the existing ones.)

In `ingestEvent` (lines 265-277), insert the intake between the `written` computation and the ledger record:

```ts
  const written = (res.meta.changes ?? 0) > 0;
  // Identity intake AFTER the event write: an unmapped subject_login raises one
  // pending identity task (login PK, INSERT OR IGNORE). Runs on unchanged
  // deliveries too, so events captured before the task store existed still
  // surface on their next redelivery/backfill overlap. The event above has
  // already landed either way — capture never depends on this.
  await ensure_identity_task(db, event.subject_login);
  if (ledger) await ledgerRecord(db, ledger, "event", written ? "written" : "unchanged", event.semantic_key);
  return written ? { outcome: "written", id: res.meta.last_row_id as number } : { outcome: "unchanged" };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/identity-intake.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the FULL suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green. Existing webhook/backfill/mywork tests ingest events with various logins — they may now create `identity_tasks` rows as a side effect, which is fine (no existing test reads that table, and it is truncated per test). If `typecheck` flags `IdentityTaskRow` as unused in writes.ts, drop it from the import until Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/tools/writes.ts src/consumer.ts test/identity-intake.test.ts
git commit -m "feat(triage): raise identity tasks for unknown logins on event capture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `map_identity` — the `people` table's first runtime write path

The resolve (spec: "mapping writes `people[login] = person`, the people table's first runtime write path... A direct authored write in the human-placement class, not a gate re-run. Then mark the task resolved. No backfill."). Follows the codebase's idempotent-resolve pattern (`resolve_triage`, `src/tools/writes.ts:316-339`): resolving an already-resolved task surfaces the recorded mapping without re-writing.

**Files:**
- Modify: `src/tools/writes.ts` (new function after `ensure_identity_task`)
- Test: `test/identity-map.test.ts`

**Interfaces:**
- Consumes: `identity_tasks` + `IdentityTaskRow` (Task 1), `ensure_identity_task` behavior (Task 2 — tests create tasks by ingesting events).
- Produces: `map_identity(db: DB, login: string, person: string, by: string): Promise<{ login: string; person: string; status: "resolved" }>` exported from `src/tools/writes.ts`. Throws `no such identity task: <login>` when no task exists. Task 4's route calls exactly this.

- [ ] **Step 1: Write the failing test**

Create `test/identity-map.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { map_identity } from "../src/tools/writes";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged",
  event_type: "pr_merged",
  ref_number: 7,
  subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("map_identity — people's only runtime write path", () => {
  it("writes the people row and soft-resolves the task with audit columns", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");

    const res = await map_identity(env.DB, "mystery-dev", "Casey", "andres");
    expect(res).toEqual({ login: "mystery-dev", person: "Casey", status: "resolved" });

    const person = await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`);
    expect(person?.person).toBe("Casey");

    // Soft resolve: the row remains, flipped with the audit trail.
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.status).toBe("resolved");
    expect(task?.resolved_by).toBe("andres");
    expect(task?.resolved_at).toBeTruthy();
  });

  it("double-map is idempotent-safe: surfaces the recorded mapping, never re-writes", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");
    await map_identity(env.DB, "mystery-dev", "Casey", "andres");

    const second = await map_identity(env.DB, "mystery-dev", "Somebody Else", "jose");
    expect(second).toEqual({ login: "mystery-dev", person: "Casey", status: "resolved" }); // the FIRST mapping stands

    const people = await all<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`);
    expect(people.length).toBe(1);
    expect(people[0].person).toBe("Casey");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.resolved_by).toBe("andres"); // audit trail untouched by the replay
  });

  it("throws on a login with no identity task (people is never written)", async () => {
    await expect(map_identity(env.DB, "nobody-here", "Ghost", "andres")).rejects.toThrow("no such identity task: nobody-here");
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'nobody-here'`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/identity-map.test.ts`
Expected: FAIL — `map_identity` is not exported from `../src/tools/writes`.

- [ ] **Step 3: Implement `map_identity` in `src/tools/writes.ts`**

Ensure the line-1 type import includes `PersonRow, IdentityTaskRow` (added in Task 2 Step 3). Add after `ensure_identity_task`:

```ts
/**
 * Human placement (Maintenance group): resolve an identity task by mapping the
 * login to a person. Performs the `people` table's ONLY runtime write (an
 * upsert over the 0012 seed), then soft-resolves the task with the audit
 * columns. A direct authored write in the human-placement class — never a gate
 * re-run. My Work resolves login→person at read time, so the mapping
 * retroactively surfaces every already-captured event for this login with no
 * backfill. Idempotent-safe: mapping an already-resolved task surfaces the
 * recorded mapping without re-writing anything.
 */
export async function map_identity(
  db: DB,
  login: string,
  person: string,
  by: string
): Promise<{ login: string; person: string; status: "resolved" }> {
  const task = await first<IdentityTaskRow>(db, `SELECT * FROM identity_tasks WHERE login = ?`, login);
  if (!task) throw new Error(`no such identity task: ${login}`);
  if (task.status === "resolved") {
    // Already resolved — idempotent no-op, surface the recorded mapping.
    const existing = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
    return { login, person: existing?.person ?? person, status: "resolved" };
  }
  await run(
    db,
    `INSERT INTO people (login, person) VALUES (?, ?)
     ON CONFLICT(login) DO UPDATE SET person = excluded.person`,
    login,
    person
  );
  await run(
    db,
    `UPDATE identity_tasks SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE login = ?`,
    nowIso(),
    by,
    login
  );
  return { login, person, status: "resolved" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/identity-map.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/writes.ts test/identity-map.test.ts
git commit -m "feat(triage): map_identity resolve — people's first runtime write path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Identity list read (live activity sample) + cookie-gated routes + route grouping

The read and the routes (spec: "do not copy activity into the task... the sample is `SELECT ... FROM events WHERE subject_login = ? LIMIT n`. The identity list route returns pending tasks each with a small live sample" / "Route: cookie-gated, human-only."). Also build-order step 4: group the routes — Review (proposals + decisions) vs Maintenance (needs_triage + identity) — as banner comments in `src/routes.ts`; the groups are served by different route groups already, no backend coupling.

**Files:**
- Modify: `src/tools/reads.ts` (imports at line 1; new section after `list_proposals`, ~line 117)
- Modify: `src/routes.ts` (imports at lines 8-9; new routes after the `/needs-triage/:id/assign` route, ~line 177; two banner comments)
- Test: `test/identity-routes.test.ts`

**Interfaces:**
- Consumes: `IdentityTaskRow` (Task 1), event-ingest-raises-task (Task 2), `map_identity` (Task 3), `getMyWork` (`src/tools/mywork.ts:59` — for the retroactive-mapping proof).
- Produces: `list_identity_tasks(db: DB): Promise<IdentityTaskWithSample[]>` and the exported interfaces `IdentitySample { semantic_key: string; event_type: string; ref_number: number; title: string | null; occurred_at: string | null }`, `IdentityTaskWithSample extends IdentityTaskRow { sample: IdentitySample[] }` from `src/tools/reads.ts`; routes `GET /identity-tasks` → `{ tasks: IdentityTaskWithSample[] }` and `POST /identity-tasks/:login/map` (body `{ person: string }`) → `{ ok: true, login, person, status: "resolved" }` (400 on missing person / unknown task, 401 without a cookie). The frontend brief consumes these shapes.

- [ ] **Step 1: Write the failing test**

Create `test/identity-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { getMyWork } from "../src/tools/mywork";
import type { IdentityTaskWithSample } from "../src/tools/reads";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

async function authedCookie(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const getJson = async <T>(path: string, cookie: string): Promise<T> =>
  (await (await app.request(path, { headers: { cookie } }, env)).json()) as T;

// A merged-PR event whose raw carries everything getMyWork's projection parses
// (number, title, html_url, merged) — so the retroactive test is end-to-end real.
const prEvent = (n: number, login: string, title: string, occurredAt: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`,
  event_type: "pr_merged",
  ref_number: n,
  subject_login: login,
  raw: JSON.stringify({
    pr: { number: n, title, body: "b", html_url: `https://github.com/SaplingLearn/sapling/pull/${n}`, merged: true, merged_at: occurredAt, closed_at: occurredAt, user: { login }, milestone: null },
  }),
  provenance: "webhook",
  occurred_at: occurredAt,
});

describe("GET /identity-tasks", () => {
  it("lists pending tasks with a small LIVE sample: newest-first, capped at 3, titles extracted from raw", async () => {
    const cookie = await authedCookie("andres");
    for (let i = 1; i <= 4; i++) {
      await ingestEvent(env.DB, prEvent(i, "mystery-dev", `PR number ${i}`, `2026-07-0${i}T10:00:00Z`), "github-webhook");
    }

    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(1);
    expect(tasks[0].login).toBe("mystery-dev");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].sample.length).toBe(3); // capped — 4 events captured
    expect(tasks[0].sample[0]).toMatchObject({
      semantic_key: "gh:pr:4:merged",
      event_type: "pr_merged",
      ref_number: 4,
      title: "PR number 4", // extracted from the event's own raw
      occurred_at: "2026-07-04T10:00:00Z",
    });
  });

  it("a malformed raw yields title:null instead of failing the list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(
      env.DB,
      { ...prEvent(5, "glitchy-dev", "x", "2026-07-05T10:00:00Z"), raw: "not json at all" },
      "github-webhook"
    );
    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks[0].sample[0].title).toBeNull();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/identity-tasks", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /identity-tasks/:login/map", () => {
  it("maps the login, resolves the task, and drops it from the pending list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");

    const res = await post("/identity-tasks/mystery-dev/map", cookie, { person: "Casey" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, login: "mystery-dev", person: "Casey", status: "resolved" });

    expect((await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`))?.person).toBe("Casey");
    const { tasks } = await getJson<{ tasks: unknown[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(0); // leaves the queue
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(row?.status).toBe("resolved"); // soft — the row remains
    expect(row?.resolved_by).toBe("andres");
  });

  it("400 on a missing/empty person and on an unknown login", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    expect((await post("/identity-tasks/mystery-dev/map", cookie, {})).status).toBe(400);
    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "   " })).status).toBe(400);
    expect((await post("/identity-tasks/nobody-here/map", cookie, { person: "Ghost" })).status).toBe(400);
  });

  it("returns 401 without a session cookie (and does not mutate)", async () => {
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    const res = await app.request("/identity-tasks/mystery-dev/map", { method: "POST" }, env);
    expect(res.status).toBe(401);
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`)).toBeNull();
  });

  // Settled decision 5: identity mapping is retroactive for free — My Work
  // resolves login→person at READ time, so one people row surfaces all of the
  // login's already-captured events with no backfill job.
  it("retroactively surfaces already-captured events in My Work — no backfill", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "First PR", "2026-07-01T10:00:00Z"), "github-webhook");
    await ingestEvent(env.DB, prEvent(2, "mystery-dev", "Second PR", "2026-07-02T10:00:00Z"), "github-webhook");

    // Before mapping: captured but unsurfaced (empty projection, degraded:false).
    const before = await getMyWork(env.DB, "mystery-dev");
    expect(before).toEqual({ person: null, previousActivity: [], todo: [], degraded: false });

    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "Casey" })).status).toBe(200);

    // After mapping: BOTH pre-existing events surface, purely at read time.
    const after = await getMyWork(env.DB, "mystery-dev");
    expect(after.person).toBe("Casey");
    expect(after.previousActivity.length).toBe(2);
    expect(after.previousActivity[0].title).toBe("Second PR"); // newest first
    expect(after.degraded).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/identity-routes.test.ts`
Expected: FAIL — `list_identity_tasks`/`IdentityTaskWithSample` not exported; `/identity-tasks` returns 404.

- [ ] **Step 3: Add the read to `src/tools/reads.ts`**

Extend the line-1 type import:

```ts
import type { DocRow, DocVersionRow, FeedRow, AdrRow, NeedsTriageRow, MilestoneProposalRow, MilestoneRow, MilestoneProgressRow, PlanRow, EventRow, IdentityTaskRow } from "@shared/rows";
```

Add after `list_proposals` (after line 116):

```ts
// ── Identity triage (Maintenance group) ───────────────────────────────────────

// One sampled event on an identity task: enough for a human to recognize whose
// work this login is. `title` comes from the event's own raw snapshot (PR or
// issue); a malformed raw yields null rather than failing the list.
export interface IdentitySample {
  semantic_key: string;
  event_type: string;
  ref_number: number;
  title: string | null;
  occurred_at: string | null;
}
export interface IdentityTaskWithSample extends IdentityTaskRow {
  sample: IdentitySample[];
}

const IDENTITY_SAMPLE_LIMIT = 3;

function titleFromRaw(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { pr?: { title?: string }; issue?: { title?: string } };
    return parsed.pr?.title ?? parsed.issue?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Pending identity tasks, each with a small LIVE activity sample. Activity is
 * never copied onto the task — events are already stored by raw login, so the
 * sample is just a per-login SELECT at read time (the queue is human-scale).
 */
export async function list_identity_tasks(db: DB): Promise<IdentityTaskWithSample[]> {
  const tasks = await all<IdentityTaskRow>(
    db,
    `SELECT * FROM identity_tasks WHERE status = 'pending' ORDER BY first_seen DESC, login ASC`
  );
  const out: IdentityTaskWithSample[] = [];
  for (const t of tasks) {
    const rows = await all<EventRow>(
      db,
      `SELECT * FROM events WHERE subject_login = ? ORDER BY occurred_at DESC, id DESC LIMIT ${IDENTITY_SAMPLE_LIMIT}`,
      t.login
    );
    out.push({
      ...t,
      sample: rows.map((e) => ({
        semantic_key: e.semantic_key,
        event_type: e.event_type,
        ref_number: e.ref_number,
        title: titleFromRaw(e.raw),
        occurred_at: e.occurred_at,
      })),
    });
  }
  return out;
}
```

- [ ] **Step 4: Add the routes to `src/routes.ts`**

Extend the imports (lines 8-9):

```ts
import { get_doc, list_docs, get_feed, query, list_needs_triage, list_adrs, list_milestone_proposals, list_proposals, list_identity_tasks } from "./tools/reads";
import { promote_doc, ratify_adr, promote_milestone_proposal, reject_milestone_proposal, complete_milestone, reject_doc_version, reject_adr, resolve_triage, assign_triage, map_identity, type AssignType } from "./tools/writes";
```

Add a Review-group banner above the `/proposals` route (line 87, replacing the leading blank line before the existing comment):

```ts
// ── Review group (session-cookie only, NEVER MCP): Proposals (staged doc
// versions) + Decisions (ADR drafts) — GET /proposals, GET /adrs, and their
// promote/ratify/reject resolves above. Agent produces, human confirms. ──────
```

Then add the identity routes directly after the `/needs-triage/:id/assign` route (after line 177):

```ts
// ── Maintenance group (session-cookie only, NEVER MCP): Unplaced items
// (/needs-triage + assign/discard above) + Identity (below). ─────────────────

// Pending unknown-login identity tasks, each with a small LIVE activity sample
// pulled from `events` at read time — activity is never copied onto the task.
app.get("/identity-tasks", async (c) => c.json({ tasks: await list_identity_tasks(c.env.DB) }));

// Human placement (session-gated): map a login to a person. The `people`
// table's ONLY runtime write (a direct authored write, not a gate re-run),
// then a soft resolve of the task. My Work picks the mapping up at read time,
// so every already-captured event for this login surfaces with no backfill.
app.post("/identity-tasks/:login/map", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { person?: string } | null;
  const person = typeof body?.person === "string" ? body.person.trim() : "";
  if (!person) return c.json({ error: "person (non-empty string) required" }, 400);
  try {
    const res = await map_identity(c.env.DB, c.req.param("login"), person, c.get("principal").login);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/identity-routes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/tools/reads.ts src/routes.ts test/identity-routes.test.ts
git commit -m "feat(triage): identity list + map-to-person routes (maintenance group)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Verification sweep — intake reachability, auth classes, suite health

Build-order step 5, adapted to what has actually landed. The spec's "confirm feed no longer reaches `route_triage`" is conditional on the companion feed spec (`canopy-build-feed-triage.md`) landing — it has NOT, so this task documents the current reachability instead of forcing it. Existing triage tests (`test/triage-writeback.test.ts`, `test/triage-reads.test.ts`, `test/render.triage.test.ts`) stay valid because assign/discard/promote/ratify/reject behavior is unchanged by this spec; the "new shape" additions are the identity tests from Tasks 1–4. No production code changes are expected in this task — it is a gate, not a build step.

**Files:**
- Verify (no planned modifications): `src/consumer.ts`, `src/mcp.ts`, `test/triage-writeback.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: a verification report in the task's final output (paste the grep results and test summary).

- [ ] **Step 1: Audit what reaches `route_triage`**

Run: `grep -rn "route_triage" src/ --include="*.ts"`
Expected callers (definition at `src/tools/writes.ts:134` aside), all in `src/consumer.ts`:
- `ingestFeedEntry` (unknown tag) — **stays until `canopy-build-feed-triage.md` lands** (settled decision 4 is satisfied by that spec, not this one).
- `ingestDocProposal` (out-of-vocab section; low-confidence NEW slug) — stays (spec: low-confidence doc items route in).
- `ingestAdrDraft` (low confidence) — stays (spec: low-confidence ADR items route in).
- `ingestMilestoneProposal` (status done; low confidence) — **retires with the Phase 2 teardown**, not here.
- `consume()`'s explicit `needs_triage` payload arm — stays (spec: the explicit arm routes in).

Anything OUTSIDE this list is a regression — stop and investigate.

- [ ] **Step 2: Confirm no MCP surface touches any triage queue**

Run: `grep -n "identity\|needs_triage\|list_proposals\|triage" src/mcp.ts`
Expected: no matches (or only matches inside comments). The bearer surface must not gain identity/triage tools.

- [ ] **Step 3: Confirm the identity routes are inside the cookie gate**

Run: `grep -n "identity-tasks\|sessionGate" src/routes.ts`
Expected: `app.use("*", sessionGate)` appears BEFORE both `app.get("/identity-tasks", ...)` and `app.post("/identity-tasks/:login/map", ...)` (line order in the file). The 401 tests from Task 4 already prove this behaviorally.

- [ ] **Step 4: Full suite + typecheck, final**

Run: `npx vitest run && npm run typecheck`
Expected: every test file green (including all pre-existing triage, webhook, backfill, mywork, dashboard suites) and a clean typecheck. If any pre-existing triage test fails, this plan broke an unchanged surface — fix the regression, do not edit the old test to match.

- [ ] **Step 5: Report**

No commit (nothing should have changed). Summarize: the grep outputs from Steps 1–3, the test/typecheck summary, and the two explicitly deferred confirmations (feed decoupling → `canopy-build-feed-triage.md`; milestones-queue teardown incl. `test/triage-writeback.test.ts`'s milestone-proposal describe block → Phase 2 pass).

---

## Deferred (tracked, not built here)

- **Feed decoupling from triage** — owned by `canopy-build-feed-triage.md`. When it lands, re-run Task 5 Step 1 and expect the `ingestFeedEntry` caller to be gone.
- **Milestones queue teardown** — `list_milestone_proposals` (`src/tools/reads.ts:118-120`), `GET /milestone-proposals` (`src/routes.ts:85`), promote/reject routes (`src/routes.ts:199`, `:212`), the assign milestone arm (`src/tools/writes.ts:405-410`), the `milestone_proposals` table + its truncation entry, and the milestone-proposal tests. Rides the Phase 2 pass.
- **All frontend** — `canopy-triage-frontend-brief.md` consumes the route shapes in Task 4's Interfaces block.
- **Resolved-item history view; compose/edit for free-form unplaced items** — spec-deferred.
