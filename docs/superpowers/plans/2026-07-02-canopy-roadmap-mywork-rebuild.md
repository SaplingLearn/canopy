# Canopy Roadmap + My Work Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild My Work (captured GitHub events, two lists) and Roadmap (admin-authored plan + event-derived progress cache) with zero live GitHub at render, per the settled spec `docs/superpowers/specs/2026-07-02-canopy-roadmap-mywork-build.md`.

**Architecture:** A GitHub webhook (third auth class, HMAC) captures PR/issue events into a D1 event log through a new `ingestEvent` arm of the existing gate. A Workers-AI summarizer condenses each completed PR's own body at capture time. The roadmap plan lives in the ALTERed `milestones` table + a `plan` singleton + `plan_versions` snapshots, written direct (promote-class) via a new `update_plan` MCP tool; progress is an absolute-value cache written by the webhook and a `scheduled()` recompute backstop. Render surfaces then flip to D1-only, and focus + the per-user GitHub token retire.

**Tech Stack:** Cloudflare Worker (Hono, D1, Workers AI binding, cron triggers), Zod contract, MCP SDK, Vite SPA (HTML-string renderer, `marked`+DOMPurify), Vitest + Miniflare D1.

## Global Constraints

- Spec file is the execution authority: `docs/superpowers/specs/2026-07-02-canopy-roadmap-mywork-build.md`. Its "Settled decisions" are NOT reopenable.
- Phases in build order 0 → 1 → 3 → 4. Phase 2 (milestone_proposals retirement, triage-assign rework) is OUT OF SCOPE — leave `milestone_proposals`, its routes, `ingestMilestoneProposal`, `stage_milestone_proposal`, promote/reject/complete, and the Triage milestones queue standing.
- Never remove `POST /ingest`, `consume()`, `append_feed`, or the `milestones` table (ALTER only).
- Test posture is behavioral: every new test must fail if the behavior is reverted. Cite file:line + command + output when verifying.
- All writes funnel per class: ingested content → gate (`consume()`/`ingest*`); authored (plan) and computed (progress, summary) → direct writers (promote class). Never add a second ingest surface.
- Webhook = third auth class: HMAC `X-Hub-Signature-256` against new secret `GITHUB_WEBHOOK_SECRET` (NOT `COOKIE_SECRET`), verified in the `index.ts` branch BEFORE the gate; never touches `sessionGate`.
- The writer identity is always the authenticated principal; `subject_login` is a separate identity trusted only post-HMAC.
- Milestone `status:'done'` is set ONLY by `complete_milestone` (existing) or the new plan write — never event-inferred.
- No live GitHub and no live generation at render, after Phase 3.
- `shared/` is the only cross-layer import (`@shared` alias). D1 helpers: `first`/`all`/`run`/`nowIso` from `src/db.ts`.
- GitHub I/O and AI are dependency-injected (`fetchImpl?: typeof fetch`, `Summarizer`) — tests stub at the Response/interface level, never hit the network.
- New tables MUST be added to the truncation list in `test/apply-migrations.ts:14` AND the hardcoded copy in `test/fts-isolation.test.ts:15-16`.
- Frontend follows the existing visual language: inline styles + `cnpy-` classes + CSS tokens (`--accent`, `--fg-55`, `--border`, `MW_LABEL`, etc.) from `web/src/render.ts`/`canopy.css`. Markdown renders through `web/src/markdown.ts` `renderMarkdown` inside a `cnpy-md` wrapper.
- Commit after each task (small commits). Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run per-task: `npx vitest run test/<file>.test.ts`; per-phase: `npm test && npm run typecheck` (typecheck is NOT part of `npm test`).

---

## Current-state facts an implementer needs (verified 2026-07-02)

- `src/index.ts` default-exports `{ fetch }` satisfies `ExportedHandler<Env>`; `/mcp` branch at lines 10-21; NO `scheduled` member exists anywhere.
- `wrangler.toml` has `[assets]`, `[[d1_databases]]`, `[vars] GITHUB_REPO="SaplingLearn/canopy"`, `CONTENT_REPO="SaplingLearn/sapling"`, `[observability]`. No `[ai]`, no `[triggers]`.
- `src/env.ts` — the `Env` interface (10 lines). Test env types: `test/env.d.ts` (augment when adding bindings).
- Gate: `src/consumer.ts` — `ingestFeedEntry`/`ingestDocProposal`/`ingestAdrDraft`/`ingestMilestoneProposal`/`ingestFocusUpdate` + `consume()` (line 277) with stable item_index enumeration order feed → docs → adrs → milestones → focus → triage. Replay ledger `processed_items` keyed (session_id, item_index).
- MCP tools registered in `src/mcp.ts` `buildCanopyMcpServer`: query, get_doc, list_docs, get_feed, append_feed, propose_doc_update, get_roadmap (line 116, uses `getStoredToken` line 118), propose_milestone (line 124), set_focus (line 138), record_session (line 145, `IngestPayload.shape`).
- Live-GitHub render sites to delete in Phase 3: `src/tools/roadmap.ts:35,49` (inside `fetchMilestoneProgress`, which MOVES off the render path, it is not deleted), `src/tools/dashboard.ts:145,183` (`listAssignedIssues`, `fetchRoadmapMarkdown` — deleted), `src/routes.ts:182,192` + `src/mcp.ts:118` (`getStoredToken` calls — deleted).
- Focus: table `migrations/0007_focus.sql`; `get_focus` `src/tools/reads.ts:119-121`; `set_focus` `src/tools/writes.ts:425-441`; `ingestFocusUpdate` `src/consumer.ts:261-268`; consume arm `src/consumer.ts:320-324`; contract `shared/contract.ts:55-58,115`; `FocusRow` `shared/rows.ts:126-131`; DTO `shared/dashboard.ts:21-25,31`; render block `web/src/render.ts:1365-1390`; tests `test/focus-contract.test.ts`, `test/focus-write.test.ts`.
- Token: sealed at `src/auth/routes.ts:62-66` (OAuth callback upsert) and `src/auth/github.ts:69-72` (`storeToken`); read via `getStoredToken` `src/auth/github.ts:75-83`; column added in `migrations/0004_roadmap.sql` (last line).
- People map: `src/people.ts` — `LOGIN_TO_PERSON = { AndresL230: "Andres", "Jose-Gael-Cruz-Lopez": "Jose", "lpcooper-arch": "Luke", "Darkest-Teddy": "Jack" }`.
- Web: `web/src/render.ts` (1466 lines, pure HTML-string views; router `screenBody` 1430-1442; `myWorkView` 1349-1427; `roadmapView` 955-964 dispatching `roadmapDigest` (prose tab, 966-1052) / `roadmapNarrative` (timeline tab, 879-953); `roadmapEnriched` 838-877 computes pct/overdue off `m.progress:{closed,total}|null`). `web/src/api.ts` typed fetch layer; `web/src/main.ts` dispatch/loaders; `web/src/markdown.ts` `renderMarkdown(body):string` (marked+DOMPurify, `#123` autolink); `.cnpy-md` styles in `canopy.css:88-112`.
- Test patterns: HTTP → `app.request(path, init, env)` with a real sealed cookie built inline (`cookieFor` helper — copy from `test/dashboard-route.test.ts:9-15`); MCP → SDK `Client`/`buildCanopyMcpServer` over `InMemoryTransport.createLinkedPair()` (copy from `test/mcp.append_feed.test.ts:16-32`); unit → direct fn call with `env.DB`. Migrations auto-applied via `TEST_MIGRATIONS` (reads whole `migrations/` dir — a new .sql file is picked up automatically).
- Skills live in `plugins/canopy/skills/` (`.claude/skills/*` are symlinks): `canopy/SKILL.md` (+`references/querying.md`), `load-context/SKILL.md`, `record-session/SKILL.md`.
- Baseline (commit 8a78f89 + spec): `npm test` green, `npm run typecheck` green.

---

# PHASE 0 — Build the spine (no teardown)

### Task 1: Migration 0012 — the five new stores + harness registration

**Files:**
- Create: `migrations/0012_events_plan.sql`
- Modify: `shared/rows.ts` (append new row interfaces; extend `ProcessedItemRow.item_type`)
- Modify: `test/apply-migrations.ts:11-15` (truncation list)
- Modify: `test/fts-isolation.test.ts:15-16` (hardcoded truncation copy)
- Test: `test/events-schema.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces: tables `events`, `pr_summaries`, `milestone_progress`, `people`, `plan`, `plan_versions`; column `milestones.phase`; row types `EventRow`, `PrSummaryRow`, `MilestoneProgressRow`, `PersonRow`, `PlanRow`, `PlanVersionRow` in `@shared/rows`.

- [ ] **Step 1: Write the failing test**

```ts
// test/events-schema.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { EventRow, PersonRow } from "@shared/rows";

describe("0012 stores", () => {
  it("events.semantic_key is UNIQUE and INSERT OR IGNORE dedupes", async () => {
    const now = nowIso();
    const ins = (key: string) =>
      run(env.DB, `INSERT OR IGNORE INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                   VALUES (?, 'pr_merged', 42, 'AndresL230', '{}', 'webhook', ?, ?, 'github-webhook')`, key, now, now);
    const first = await ins("gh:pr:42:merged");
    expect(first.meta.changes).toBe(1);
    const dup = await ins("gh:pr:42:merged");
    expect(dup.meta.changes).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1);
  });

  it("people is seeded from the old LOGIN_TO_PERSON object", async () => {
    const people = await all<PersonRow>(env.DB, `SELECT * FROM people ORDER BY login`);
    expect(people.map((p) => [p.login, p.person])).toEqual([
      ["AndresL230", "Andres"],
      ["Darkest-Teddy", "Jack"],
      ["Jose-Gael-Cruz-Lopez", "Jose"],
      ["lpcooper-arch", "Luke"],
    ]);
  });

  it("milestones has a phase column and plan/plan_versions exist", async () => {
    await run(env.DB, `INSERT INTO milestones (title, target_date, status, phase, created_at, created_by) VALUES ('m', '2026-08-01', 'upcoming', 'Phase 1', ?, 'a')`, nowIso());
    const rows = await all<{ phase: string | null }>(env.DB, `SELECT phase FROM milestones`);
    expect(rows[0].phase).toBe("Phase 1");
    expect(await all(env.DB, `SELECT * FROM plan_versions`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify failure** — `npx vitest run test/events-schema.test.ts` → FAIL (no such table: events).

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0012_events_plan.sql
-- Phase 0 spine (roadmap/my-work rebuild): captured GitHub events, completed-PR
-- summaries, the per-milestone progress cache, the identity map, and the
-- admin-authored plan with non-destructive version snapshots.

-- The captured-event log My Work and the progress recompute read from.
-- semantic_key is the dedupe identity (e.g. 'gh:pr:42:merged'), NOT the delivery
-- GUID — manual redelivery gets a fresh GUID but the same semantic key.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semantic_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,            -- 'pr_merged' | 'pr_closed' | 'issue'
  ref_number INTEGER NOT NULL,         -- the PR/issue number (grouping key)
  subject_login TEXT NOT NULL,         -- whose work this is; trusted post-HMAC
  raw TEXT NOT NULL,                   -- JSON snapshot slice — the source of truth
  provenance TEXT NOT NULL,            -- 'webhook' | 'backfill'
  occurred_at TEXT,                    -- from the payload (ISO8601)
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL            -- writer identity (the authenticated principal)
);
CREATE INDEX idx_events_subject ON events(event_type, subject_login, occurred_at);
CREATE INDEX idx_events_ref ON events(event_type, ref_number, occurred_at);

-- Worker-generated summary of ONE completed PR's own body. A derived projection,
-- regenerable from events.raw; never the source of truth. Issue events never land here.
CREATE TABLE pr_summaries (
  semantic_key TEXT PRIMARY KEY REFERENCES events(semantic_key),
  pr_number INTEGER NOT NULL,
  summary TEXT NOT NULL,               -- short markdown
  model TEXT,                          -- generator id, or 'excerpt' for the deterministic fallback
  created_at TEXT NOT NULL
);

-- Absolute closed/total per live milestone. Written by the webhook (event-derived)
-- and the scheduled recompute (backstop). Absolute values make ordering irrelevant.
CREATE TABLE milestone_progress (
  milestone_id INTEGER PRIMARY KEY REFERENCES milestones(id),
  closed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  source TEXT NOT NULL,                -- 'event' | 'recompute'
  computed_at TEXT NOT NULL
);

-- Identity map (promotes src/people.ts). Admin-maintained; an unmapped subject's
-- events are captured but do not surface in any My Work until mapped.
CREATE TABLE people (
  login TEXT PRIMARY KEY,
  person TEXT NOT NULL
);
INSERT INTO people (login, person) VALUES
  ('AndresL230', 'Andres'),
  ('Jose-Gael-Cruz-Lopez', 'Jose'),
  ('lpcooper-arch', 'Luke'),
  ('Darkest-Teddy', 'Jack');

-- The admin-authored plan narrative (singleton row) + snapshot history.
-- Direct writes (promote class) but versioned non-destructively.
CREATE TABLE plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  narrative TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO plan (id, narrative, current_version) VALUES (1, '', 0);

CREATE TABLE plan_versions (
  version INTEGER PRIMARY KEY,
  narrative TEXT NOT NULL,
  milestones_json TEXT NOT NULL,       -- full milestones snapshot AFTER this write
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- Plan layer on milestones: a coarse phase label ("Now", "Weeks 3-4", …).
ALTER TABLE milestones ADD COLUMN phase TEXT;
```

- [ ] **Step 4: Register in the harness.** In `test/apply-migrations.ts` extend the DELETE chain (keep `people` and the `plan` singleton OUT — they are seeded like vocabulary; `plan_versions`, `events`, `pr_summaries`, `milestone_progress` are data):

```ts
  await env.DB.exec(
    "DELETE FROM processed_items; DELETE FROM events; DELETE FROM pr_summaries; DELETE FROM milestone_progress; DELETE FROM plan_versions; UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL; DELETE FROM focus; DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
  );
```

Mirror the same statement into `test/fts-isolation.test.ts` `HARNESS_TRUNCATION` (it deliberately omits the leading `DELETE FROM processed_items;` — keep that omission, add the new clauses).

- [ ] **Step 5: Add row types** to `shared/rows.ts` (append; also extend `ProcessedItemRow.item_type` union with `"event"`):

```ts
// Captured GitHub event (0012). semantic_key is the dedupe identity.
export interface EventRow {
  id: number;
  semantic_key: string;
  event_type: "pr_merged" | "pr_closed" | "issue";
  ref_number: number;
  subject_login: string;
  raw: string;             // JSON snapshot slice — the truth
  provenance: "webhook" | "backfill";
  occurred_at: string | null;
  recorded_at: string;
  recorded_by: string;
}

// Worker-generated completed-PR summary (0012). Derived, regenerable, never truth.
export interface PrSummaryRow {
  semantic_key: string;
  pr_number: number;
  summary: string;
  model: string | null;    // 'excerpt' = deterministic fallback
  created_at: string;
}

// Absolute per-milestone progress cache (0012).
export interface MilestoneProgressRow {
  milestone_id: number;
  closed: number;
  total: number;
  source: "event" | "recompute";
  computed_at: string;
}

// Identity map (0012): GitHub login → Canopy person. Admin-maintained.
export interface PersonRow {
  login: string;
  person: string;
}

// The plan singleton (0012).
export interface PlanRow {
  id: number;
  narrative: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
}

// Non-destructive plan snapshot (0012).
export interface PlanVersionRow {
  version: number;
  narrative: string;
  milestones_json: string;
  created_at: string;
  created_by: string;
}
```

Also add `phase: string | null;` to `MilestoneRow` (`shared/rows.ts:100-110`).

- [ ] **Step 6: Verify** — `npx vitest run test/events-schema.test.ts` → PASS; `npm test` → all green (fts-isolation must still pass); `npm run typecheck`.
- [ ] **Step 7: Commit** — `git add migrations/0012_events_plan.sql shared/rows.ts test/apply-migrations.ts test/fts-isolation.test.ts test/events-schema.test.ts && git commit -m "feat(db): 0012 events/plan spine — events log, pr summaries, progress cache, people, plan versions"`

---

### Task 2: `CapturedEvent` contract arm + `ingestEvent` gate + `consume()` loop

**Files:**
- Modify: `shared/contract.ts` (add `CapturedEvent`, add `events` to `IngestPayload`)
- Modify: `src/consumer.ts` (add `EventIngestResult`, `ingestEvent`, events loop in `consume`, `events` counts in `IngestResult`)
- Test: `test/events-gate.test.ts`

**Interfaces:**
- Consumes: `events` table (Task 1), `LedgerRef`/`ledgerLookup`/`ledgerRecord` (existing, `src/consumer.ts:53-81`).
- Produces:
  - `CapturedEvent` zod schema + type in `@shared/contract`: `{ semantic_key: string; event_type: "pr_merged"|"pr_closed"|"issue"; ref_number: number; subject_login: string; raw: string; provenance: "webhook"|"backfill"; occurred_at?: string }`.
  - `IngestPayload.events: CapturedEvent[]` (defaults `[]`), enumerated LAST in `consume()` (after needs_triage) so existing payload indices are replay-stable.
  - `export async function ingestEvent(db: DB, event: CapturedEvent, recordedBy: string, ledger?: LedgerRef): Promise<EventIngestResult>` where `EventIngestResult = { outcome: "written"; id: number } | { outcome: "unchanged" }`.
  - `IngestResult.events: { written: number; unchanged: number }`.

- [ ] **Step 1: Failing test**

```ts
// test/events-gate.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestEvent, consume } from "../src/consumer";
import type { EventRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:42:merged",
  event_type: "pr_merged",
  ref_number: 42,
  subject_login: "AndresL230",
  raw: JSON.stringify({ pr: { number: 42, title: "t", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("ingestEvent gate arm", () => {
  it("writes once; an identical semantic_key is unchanged (INSERT OR IGNORE)", async () => {
    expect((await ingestEvent(env.DB, ev(), "github-webhook")).outcome).toBe("written");
    expect((await ingestEvent(env.DB, ev(), "github-webhook")).outcome).toBe("unchanged");
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].subject_login).toBe("AndresL230");   // subject preserved
    expect(rows[0].recorded_by).toBe("github-webhook"); // writer = principal
  });

  it("consume() carries an events[] arm through the same gate, replay-safe", async () => {
    const payload = {
      session: { id: "evt-S1", author: "spoof", ended_at: "2026-07-01T10:00:00Z", skill_version: "2.0" },
      events: [ev(), ev({ semantic_key: "gh:pr:43:closed", event_type: "pr_closed", ref_number: 43 })],
    };
    const r1 = await consume(env.DB, structuredClone(payload) as never, { login: "AndresL230" });
    expect(r1.events).toEqual({ written: 2, unchanged: 0 });
    const r2 = await consume(env.DB, structuredClone(payload) as never, { login: "AndresL230" });
    expect(r2.events).toEqual({ written: 0, unchanged: 2 }); // replay ledger drop
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(2);
  });
});
```

Note: `consume` requires a fully-parsed payload; in the test pass the object through `IngestPayload.parse(...)` if the direct call complains about missing defaulted arrays — do `consume(env.DB, IngestPayload.parse(payload), { login: "AndresL230" })` (import `IngestPayload` from `@shared/contract`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/events-gate.test.ts` → FAIL (`ingestEvent` not exported).
- [ ] **Step 3: Contract** — in `shared/contract.ts` add after `FocusUpdate`:

```ts
// A captured GitHub event (webhook/backfill). subject_login is who the event is
// ABOUT — a second identity, distinct from the writer principal — and is trusted
// only because the webhook branch verified the delivery's HMAC before the gate.
export const CapturedEvent = z.object({
  semantic_key: z.string().min(1),   // derived identity, e.g. 'gh:pr:42:merged'
  event_type: z.enum(["pr_merged", "pr_closed", "issue"]),
  ref_number: z.number().int(),
  subject_login: z.string().min(1),
  raw: z.string(),                   // JSON snapshot slice — the truth
  provenance: z.enum(["webhook", "backfill"]),
  occurred_at: z.string().optional(),
});
```

Add to `IngestPayload`: `events: z.array(CapturedEvent).default([]),` and export `export type CapturedEvent = z.infer<typeof CapturedEvent>;`.

- [ ] **Step 4: Gate arm** — in `src/consumer.ts`: import `CapturedEvent`; add to `IngestResult` `events: { written: number; unchanged: number };` (initialize in `consume`); add:

```ts
export type EventIngestResult = { outcome: "written"; id: number } | { outcome: "unchanged" };

/** Captured events: dedupe is the UNIQUE semantic_key (INSERT OR IGNORE) — a
 *  redelivery or backfill overlap drops as unchanged. No vocab/confidence checks:
 *  the event is external fact, captured verbatim. The writer is the authenticated
 *  principal; subject_login is the event's own identity (trusted post-HMAC). */
export async function ingestEvent(db: DB, event: CapturedEvent, recordedBy: string, ledger?: LedgerRef): Promise<EventIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };
  const res = await run(
    db,
    `INSERT OR IGNORE INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.semantic_key, event.event_type, event.ref_number, event.subject_login,
    event.raw, event.provenance, event.occurred_at ?? null, nowIso(), recordedBy
  );
  const written = (res.meta.changes ?? 0) > 0;
  if (ledger) await ledgerRecord(db, ledger, "event", written ? "written" : "unchanged", event.semantic_key);
  return written ? { outcome: "written", id: res.meta.last_row_id as number } : { outcome: "unchanged" };
}
```

In `consume()`, AFTER the needs_triage loop (so existing indices stay stable):

```ts
  for (const event of payload.events) {
    const r = await ingestEvent(db, event, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.events.written++;
    else result.events.unchanged++;
  }
```

- [ ] **Step 5: Verify** — `npx vitest run test/events-gate.test.ts` → PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(gate): CapturedEvent contract arm + ingestEvent through the single gate`

---

### Task 3: GitHub webhook — the third auth class

**Files:**
- Create: `src/webhook.ts`
- Create: `test/fixtures/gh-pr-merged.json`, `test/fixtures/gh-issue-assigned.json`, `test/fixtures/gh-issue-closed.json`
- Modify: `src/index.ts` (webhook branch before `app.fetch`)
- Modify: `src/env.ts` (`GITHUB_WEBHOOK_SECRET?: string`), `test/env.d.ts`, `vitest.config.ts` (test binding `GITHUB_WEBHOOK_SECRET: "test-webhook-secret"`)
- Test: `test/webhook.test.ts`

**Interfaces:**
- Consumes: `ingestEvent` (Task 2), `CapturedEvent` type.
- Produces (from `src/webhook.ts`):
  - `export async function verifyGithubSignature(secret: string, rawBody: string, sigHeader: string | null): Promise<boolean>` — HMAC-SHA256, header format `sha256=<hex>`, constant-time via `crypto.subtle.verify`.
  - `export function eventsFromDelivery(eventName: string, payload: unknown): CapturedEvent[]` — PURE. Rules:
    - `pull_request` + `action:"closed"` → one event: `event_type` = `payload.pull_request.merged ? "pr_merged" : "pr_closed"`; `semantic_key` = `` `gh:pr:${number}:${merged ? "merged" : "closed"}` ``; `subject_login` = `pull_request.user.login`; `ref_number` = PR number; `occurred_at` = `merged_at ?? closed_at`; `raw` = `JSON.stringify({ pr: { number, title, body, html_url, merged, merged_at, closed_at, user: { login }, milestone: pull_request.milestone ? { number: pull_request.milestone.number } : null } })`.
    - `issues` + action in `["opened","edited","assigned","unassigned","closed","reopened","milestoned","demilestoned"]` → one event: `event_type:"issue"`; `semantic_key` = `` `gh:issue:${number}:${action}:${issue.updated_at}` `` for repeat-safe identity, EXCEPT assigned/unassigned which append the assignee: `` `gh:issue:${number}:${action}:${payload.assignee.login}:${issue.updated_at}` ``; `subject_login` = for assigned/unassigned `payload.assignee.login`, else `issue.assignees[0]?.login ?? issue.user.login`; `ref_number` = issue number; `occurred_at` = `issue.updated_at`; `raw` = `JSON.stringify({ action, issue: { number, title, html_url, state, updated_at, user: { login }, assignees: issue.assignees.map(a => ({ login: a.login })), labels: (issue.labels ?? []).map(l => typeof l === "string" ? l : l.name).filter(Boolean), milestone: issue.milestone ? { number, open_issues, closed_issues } : null } })`.
    - PRs masquerading as issues (payload.issue.pull_request present) → `[]`. Any other event/action → `[]`.
  - `export function progressFromIssueEvent(payload: unknown): { milestoneNumber: number; closed: number; total: number } | null` — PURE; reads `payload.issue.milestone.{number, open_issues, closed_issues}` → `{ milestoneNumber, closed: closed_issues, total: open_issues + closed_issues }`, else null.
  - `export async function handleGithubWebhook(request: Request, env: Env, opts?: { summarizer?: Summarizer | null }): Promise<Response>` — flow: no `env.GITHUB_WEBHOOK_SECRET` OR bad/missing signature → bare `401` JSON `{error:"unauthorized"}` (mirror the `/mcp` 401 shape, `src/index.ts:15-18`); read `X-GitHub-Event`; derive events; for each `ingestEvent(env.DB, ev, "github-webhook")`; newly-written PR events → summarization hook (Task 4 fills it; Task 3 leaves a `// summarize step wired in Task 4` seam calling a no-op) and milestone-progress write (Task 5's `upsertProgressForEvent` — leave seam similarly); respond `200 {ok:true, captured, unchanged}`. Unhandled event names → `200 {ok:true, ignored:true}` AFTER signature verification.
- Writer principal for webhook writes is the fixed string `"github-webhook"` (decision 7: the webhook owner is the writer; there is no OAuth principal on this surface).

`src/index.ts` becomes:

```ts
import { app } from "./routes";
import { handleMcp } from "./mcp";
import { handleGithubWebhook } from "./webhook";
import { resolveBearerPrincipal } from "./auth/principal";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer ONLY. On missing/invalid credentials: bare 401, NO WWW-Authenticate,
      // NO OAuth discovery/metadata — Claude Code must use the configured header.
      const principal = await resolveBearerPrincipal(request, env);
      if (!principal) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return handleMcp(request, env, ctx, principal);
    }
    // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
    // body against GITHUB_WEBHOOK_SECRET. Never touches sessionGate.
    if (url.pathname === "/webhook/github" && request.method === "POST") {
      return handleGithubWebhook(request, env);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Fixtures: realistic-but-trimmed GitHub payloads (a `pull_request closed` with `merged:true`, body markdown, user login `AndresL230`, milestone `{number:3, open_issues:2, closed_issues:4}`; an `issues assigned` with assignee `Jose-Gael-Cruz-Lopez`, labels incl. `[P1]`-prefixed title; an `issues closed` with milestone counts). Keep each under ~60 lines.

- [ ] **Step 1: Failing tests** — `test/webhook.test.ts` covering, at minimum (drive via `handleGithubWebhook(new Request("https://x/webhook/github", { method:"POST", headers, body }), env)` and the pure fns directly):
  1. valid signature + pr-merged fixture → 200, one `events` row (`event_type:'pr_merged'`, `subject_login:'AndresL230'`, `recorded_by:'github-webhook'`); redelivery of the same body → 200 with `captured:0, unchanged:1` and still one row.
  2. bad signature → 401, zero rows. missing header → 401. secret unset (pass an env clone without the secret) → 401.
  3. `eventsFromDelivery("issues", assignedFixture)` → subject is the assignee login; key embeds action+assignee+updated_at.
  4. `eventsFromDelivery` returns `[]` for `payload.issue.pull_request` present and for unknown actions.
  5. `progressFromIssueEvent(closedFixture)` → `{milestoneNumber, closed, total}` matching the fixture's counts.
  Signature helper for tests:

```ts
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 2: Verify failure** → module not found.
- [ ] **Step 3: Implement** `src/webhook.ts` per the interface block above. `verifyGithubSignature` must decode the hex after `sha256=` into bytes and use `crypto.subtle.verify("HMAC", key, sigBytes, bodyBytes)` (constant-time), returning false on any malformed header.
- [ ] **Step 4: Wire** `src/index.ts`, `src/env.ts`, `test/env.d.ts`, `vitest.config.ts` binding.
- [ ] **Step 5: Verify** — `npx vitest run test/webhook.test.ts` → PASS; `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(webhook): GitHub webhook branch — HMAC third auth class capturing PR/issue events`

---

### Task 4: Completed-PR summarizer (capture-time, bounded)

**Files:**
- Create: `src/tools/summarize.ts`
- Modify: `src/webhook.ts` (fill the summarize seam), `src/env.ts` (`AI?: Ai`), `wrangler.toml` (`[ai] binding = "AI"`), `test/env.d.ts`
- Test: `test/summarize.test.ts`

**Interfaces:**
- Consumes: `pr_summaries` table; `EventIngestResult` from Task 2; the Task 3 seam.
- Produces:
  - `export interface Summarizer { summarize(input: { title: string; body: string }): Promise<string | null>; }`
  - `export function workersAiSummarizer(ai: Ai): Summarizer` — calls `ai.run("@cf/meta/llama-3.1-8b-instruct", { messages })` with a prompt bounded to THAT PR's title+body only ("Summarize this one pull request's description in 2-3 short markdown sentences for a team activity feed. Do not speculate beyond the text."); returns null on any throw/empty.
  - `export function excerptSummary(title: string, body: string): string` — deterministic fallback: first 280 chars of the body with whitespace collapsed (or the title if the body is empty), suffixed `…` when truncated.
  - `export async function storePrSummary(db: DB, summarizer: Summarizer | null, pr: { semantic_key: string; pr_number: number; title: string; body: string }): Promise<PrSummaryRow>` — tries the summarizer, falls back to `excerptSummary` (model `'excerpt'`); `INSERT OR REPLACE INTO pr_summaries`; NEVER throws (a summary failure must not fail capture).
- Webhook wiring: in `handleGithubWebhook`, for each event with `event_type` `pr_merged`/`pr_closed` whose `ingestEvent` outcome was `written`, parse its own `raw` and `await storePrSummary(env.DB, opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null), …)`. Issue events must NEVER reach `storePrSummary`.

- [ ] **Step 1: Failing tests** — `test/summarize.test.ts`:
  1. `storePrSummary` with a stub summarizer (`{ summarize: async () => "- did the thing" }`) stores that summary with the model id the stub reports (design: `workersAiSummarizer` labels rows `@cf/meta/llama-3.1-8b-instruct`; `storePrSummary` accepts model via the summarizer? Simplest: `Summarizer` gains `readonly model: string`; stub uses `"stub"`).
  2. summarizer returning null / throwing → excerpt fallback stored, `model:'excerpt'`, and the call resolves (no throw).
  3. Webhook end-to-end: pr-merged fixture + stub summarizer via `handleGithubWebhook(req, env, { summarizer: stub })` → `pr_summaries` has one row keyed `gh:pr:42:merged`; replay → still one row (event unchanged → no re-summarize). Issue fixture → zero `pr_summaries` rows.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement + wire.** Add `Summarizer.model: string` so `storePrSummary` records provenance. `excerptSummary` is exported and unit-tested (truncation boundary, empty body → title).
- [ ] **Step 4: wrangler.toml** — append:

```toml
# Workers AI: capture-time summaries of completed PR bodies (never at render).
[ai]
binding = "AI"
```

`src/env.ts` gains `AI?: Ai;` (type from `@cloudflare/workers-types`, already a dev dep).

- [ ] **Step 5: Verify** — `npx vitest run test/summarize.test.ts` → PASS; `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(worker): capture-time completed-PR summarizer (Workers AI + deterministic excerpt fallback)`

---

### Task 5: Progress cache — event-derived writes + scheduled recompute backstop

**Files:**
- Create: `src/tools/progress.ts`
- Modify: `src/tools/roadmap.ts` (MOVE `fetchMilestoneProgress` out → `progress.ts`; roadmap.ts re-imports for its existing render path, unchanged behavior this phase)
- Modify: `src/webhook.ts` (fill the progress seam), `src/index.ts` (add `scheduled`), `src/env.ts` (`GITHUB_SERVICE_TOKEN?: string`), `wrangler.toml` (`[triggers]`), `test/env.d.ts`
- Modify: `test/roadmap.test.ts` (only the `fetchMilestoneProgress` import path)
- Test: `test/progress.test.ts`

**Interfaces:**
- Consumes: `milestone_progress`, `milestones`, `events` tables; `fetchMilestoneProgress` (moved verbatim from `src/tools/roadmap.ts:14-59`, same signature).
- Produces (from `src/tools/progress.ts`):
  - `export { fetchMilestoneProgress }` (moved).
  - `export async function upsertProgress(db: DB, milestoneId: number, closed: number, total: number, source: "event" | "recompute"): Promise<void>` — `INSERT INTO milestone_progress … ON CONFLICT(milestone_id) DO UPDATE SET closed/total/source/computed_at` (absolute values).
  - `export async function getProgress(db: DB): Promise<Map<number, MilestoneProgressRow>>`.
  - `export async function applyEventProgress(db: DB, payload: unknown): Promise<void>` — the webhook-side write: (a) `progressFromIssueEvent(payload)` non-null → find milestones whose `github_ref` (JSON) equals that milestone number → `upsertProgress(..., 'event')`; (b) for milestones whose `github_ref` is a JSON array containing the event's issue number → recount from the events store: total = array length, closed = count of array members whose LATEST `issue` event snapshot has `state:"closed"` → `upsertProgress(..., 'event')`. Latest-snapshot SQL:

```sql
SELECT ref_number, raw FROM (
  SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
  FROM events WHERE event_type = 'issue' AND ref_number IN (…)
) WHERE rn = 1
```

  - `export async function recomputeAllProgress(db: DB, opts: { token: string; repo: string; fetchImpl?: typeof fetch }): Promise<{ updated: number }>` — for every milestone with a `github_ref`: `fetchMilestoneProgress` → non-null → `upsertProgress(..., 'recompute')`; null → leave the existing cache row alone (never a 500, never a wipe).
- `src/index.ts` gains a `scheduled` member on the default export (alongside `fetch`):

```ts
  // Backstop: recompute per-milestone progress from GitHub on a schedule with the
  // app-level service token — a computed direct writer (promote class), never on
  // the render path.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.GITHUB_SERVICE_TOKEN || !env.GITHUB_REPO) return;
    await recomputeAllProgress(env.DB, { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO });
  },
```

- `wrangler.toml`:

```toml
# Scheduled backstop for the milestone progress cache (event-derived writes are primary).
[triggers]
crons = ["0 */6 * * *"]
```

- [ ] **Step 1: Failing tests** — `test/progress.test.ts`:
  1. `upsertProgress` inserts then overwrites absolutely (write 3/10 then 5/10 → row reads 5/10, `source` updated).
  2. `applyEventProgress` with the issue-closed fixture (milestone number matching a seeded `milestones.github_ref = '3'`) → cache row `{closed:4,total:6,source:'event'}`.
  3. array-ref: seed milestone `github_ref='[7,8]'`, capture latest snapshots (issue 7 closed, issue 8 open) via `ingestEvent`, then `applyEventProgress` for issue 7's payload → `{closed:1,total:2}`.
  4. `recomputeAllProgress` with a stubbed `fetchImpl` (copy the `stubFetch` pattern from `test/roadmap.test.ts:96-103`) → writes `source:'recompute'`; a failing fetch (401) leaves the prior cache row untouched.
  5. Webhook end-to-end: issue-closed fixture through `handleGithubWebhook` → cache row exists.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `progress.ts`; move `fetchMilestoneProgress` (delete from `roadmap.ts`, import there from `./progress`); fill the webhook seam (`applyEventProgress` called for `issue` events after capture — also for pr events whose raw carries a milestone? No: only issue events carry authoritative milestone counts; keep it issues-only). Update the `test/roadmap.test.ts` import (`fetchMilestoneProgress` now from `../src/tools/progress`).
- [ ] **Step 4: Wire** `scheduled` + `[triggers]` + env additions. Test the scheduled path as a direct call to `recomputeAllProgress` (behavioral) — do not attempt to fake cron.
- [ ] **Step 5: Verify** — `npx vitest run test/progress.test.ts test/roadmap.test.ts` → PASS; `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(progress): absolute progress cache — webhook event writes + scheduled recompute backstop`

---

### Task 6: My Work projection + `get_my_work` / `get_events` MCP reads

**Files:**
- Create: `src/tools/mywork.ts`
- Modify: `src/mcp.ts` (register `get_my_work`, `get_events`)
- Test: `test/mywork.test.ts`, `test/mcp.mywork.test.ts`

**Interfaces:**
- Consumes: `events`, `pr_summaries`, `people` tables; latest-snapshot SQL pattern (Task 5).
- Produces (from `src/tools/mywork.ts`):

```ts
export interface MyWorkPr { number: number; title: string; url: string; merged: boolean; occurredAt: string; summary: string | null; }
export interface MyWorkTodo { number: number; title: string; priority: "P0" | "P1" | "P2" | "P3" | null; labels: string[]; url: string; updatedAt: string; }
export interface MyWork { person: string | null; previousActivity: MyWorkPr[]; todo: MyWorkTodo[]; degraded: boolean; }
export async function getMyWork(db: DB, login: string, opts?: { now?: string }): Promise<MyWork>
export async function list_events(db: DB, filter?: { type?: "pr_merged" | "pr_closed" | "issue"; subject?: string; limit?: number }): Promise<EventRow[]>
```

  - `getMyWork` rules (decision 2 + 9): person from `people` by login; UNMAPPED login → `{ person: null, previousActivity: [], todo: [], degraded: false }` (captured, not surfaced). previousActivity = events `pr_merged|pr_closed` with `subject_login = login` AND `occurred_at >=` (now − 14 days, ISO comparison; compute cutoff in TS from `opts?.now ?? nowIso()`), LEFT JOIN `pr_summaries` on semantic_key, DESC by occurred_at; title/url/merged parsed from `raw.pr`. todo = latest `issue` snapshot per ref_number (window-fn SQL), parsed, filtered to `state === "open"` AND `assignees` containing login; priority via the `[P0-3]` title-prefix convention — REIMPLEMENT `priorityOf`/`stripPriority` here (copy from `src/tools/dashboard.ts:126-132`; dashboard.ts is rewritten in Phase 3). Any D1 throw → `{ person: null, previousActivity: [], todo: [], degraded: true }`.
- MCP (in `buildCanopyMcpServer`):

```ts
  server.tool(
    "get_my_work",
    "Your personal My Work projection from captured GitHub events (no live GitHub): previous-activity (summarized merged/closed PRs, last 14 days) and to-do (your open assigned issues). Read-only.",
    {},
    async () => runTool(() => getMyWork(env.DB, principal.login))
  );

  server.tool(
    "get_events",
    "Recent captured GitHub events (raw log behind My Work and roadmap progress). Filter by type/subject. Read-only.",
    { type: z.enum(["pr_merged", "pr_closed", "issue"]).optional(), subject: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => list_events(env.DB, args))
  );
```

- [ ] **Step 1: Failing tests.** `test/mywork.test.ts` (direct fn, seed via `ingestEvent`):
  1. previous-activity windows to 14 days: seed a merged-PR event 3 days old and one 20 days old (control `opts.now`) → only the recent one returns, with its stored summary joined.
  2. subject filtering: another person's PR event does not appear.
  3. todo latest-snapshot semantics: issue 7 assigned-to-login snapshot (open) then a later closed snapshot → todo is empty; reopen snapshot → present again. Priority `[P1]` stripped + parsed; labels parsed.
  4. unmapped login (e.g. `"stranger"`) → empty projection, `person:null`, `degraded:false` — and the events rows still exist (captured, never dropped).
  `test/mcp.mywork.test.ts` (InMemoryTransport pattern from `test/mcp.append_feed.test.ts`): `get_my_work` returns the CALLING principal's projection (seed two people's events; principal `AndresL230` sees only theirs); `get_events` respects `type` filter.
- [ ] **Step 2: failure** → module not found.
- [ ] **Step 3-4: Implement + register.**
- [ ] **Step 5: Verify** — `npx vitest run test/mywork.test.ts test/mcp.mywork.test.ts`; `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(mywork): D1 My Work projection + get_my_work/get_events bearer reads`

---

### Task 7: Plan store — direct, versioned plan write + `update_plan` MCP tool

**Files:**
- Create: `src/tools/plan.ts`
- Modify: `src/mcp.ts` (register `update_plan`)
- Test: `test/plan.test.ts`, `test/mcp.plan.test.ts`

**Interfaces:**
- Consumes: `plan`, `plan_versions`, `milestones`, `milestone_progress` (via `getProgress`, Task 5).
- Produces (from `src/tools/plan.ts`):

```ts
export interface PlanMilestoneInput {
  id?: number;                     // present = update that milestone; absent = create
  title: string;
  description?: string | null;
  phase?: string | null;
  target_date: string;
  status: "upcoming" | "in_progress" | "done";   // 'done' allowed HERE ONLY (admin-authored)
  github_ref?: number | number[] | null;
}
export interface PlanWrite { narrative: string; milestones: PlanMilestoneInput[]; }
export interface PlanView {
  narrative: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  milestones: (MilestoneRow & { progress: { closed: number; total: number; computed_at: string } | null })[];
}
export async function write_plan(db: DB, input: PlanWrite, author: string): Promise<{ version: number; milestones: MilestoneRow[] }>
export async function get_plan(db: DB): Promise<PlanView>
```

  - `write_plan` (promote-class direct writer, versioned non-destructively): ensure the `plan` singleton exists (`INSERT OR IGNORE … (1,'',0)` — resilience); `version = current_version + 1`; for each milestone input: with `id` → UPDATE title/description/phase/target_date/status/github_ref (`github_ref` stored as JSON string or NULL) + `updated_at`; throw `no such milestone: <id>` if absent; without `id` → INSERT (`created_by = author`). Milestones NOT mentioned are left untouched (no implicit deletes). Then UPDATE `plan` (narrative, current_version, updated_at, updated_by) and snapshot the FULL post-write milestones list as `milestones_json` into `plan_versions`.
  - `get_plan`: plan row (default empty view when the singleton is missing) + all milestones `ORDER BY target_date ASC, id ASC` merged with the progress cache. NO GitHub, NO token.
- MCP:

```ts
  server.tool(
    "update_plan",
    "ADMIN plan write: replace the roadmap narrative and create/update milestones (including status 'done') in one direct, non-destructively versioned write — same authored-write class as promote, NOT the ingestion gate. Milestones not listed are untouched. Use via the update-plan skill.",
    {
      narrative: z.string(),
      milestones: z.array(z.object({
        id: z.number().int().optional(),
        title: z.string(),
        description: z.string().nullable().optional(),
        phase: z.string().nullable().optional(),
        target_date: z.string(),
        status: z.enum(["upcoming", "in_progress", "done"]),
        github_ref: z.union([z.number(), z.array(z.number())]).nullable().optional(),
      })).default([]),
    },
    async (input) => runTool(() => write_plan(env.DB, input as PlanWrite, principal.login))
  );
```

- [ ] **Step 1: Failing tests.** `test/plan.test.ts`:
  1. first write creates version 1 (snapshot row exists, `milestones_json` parses to the created milestone), second write → version 2, BOTH snapshots remain (non-destructive).
  2. update-by-id changes title/status; admin CAN set `status:'done'` through `write_plan` (assert the milestone row flips) — this is the one legal done-setter besides `complete_milestone`.
  3. unknown id throws `no such milestone`.
  4. unmentioned milestones untouched.
  5. `get_plan` merges the progress cache (seed via `upsertProgress`) and returns `progress: null` for uncached milestones.
  `test/mcp.plan.test.ts`: `update_plan` via InMemoryTransport writes as the bearer principal (author stamped from principal, not payload).
- [ ] **Step 2-4: fail → implement → register.**
- [ ] **Step 5: Verify** — `npx vitest run test/plan.test.ts test/mcp.plan.test.ts`; `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(plan): admin plan store — write_plan/get_plan + update_plan MCP (direct, versioned)`

---

### Task 8: Backfill script + replayed-delivery verification

**Files:**
- Create: `scripts/backfill-events.mjs`
- Test: manual/behavioral — replay a fixture delivery against `wrangler dev` and run the backfill against it.

**Interfaces:**
- Consumes: the live `/webhook/github` endpoint (Task 3), GitHub REST (`gh api` or `GITHUB_TOKEN`).
- Produces: a Node script; env: `WEBHOOK_URL` (default `http://localhost:8787/webhook/github`), `GITHUB_WEBHOOK_SECRET`, `REPO` (default `SaplingLearn/sapling`), `GITHUB_TOKEN` (or `gh auth token`). Fetches (a) PRs closed in the last 14 days, (b) all open issues; synthesizes `pull_request closed` / `issues assigned-or-opened` delivery bodies (same slice shapes as the fixtures); POSTs each with a computed `X-Hub-Signature-256` and the right `X-GitHub-Event` header; prints per-delivery outcome counts. Idempotent by construction (semantic keys).

- [ ] **Step 1: Write the script** (plain node 18+, no deps: `node:crypto` `createHmac` for the signature).
- [ ] **Step 2: Local verification (behavioral).** Add `GITHUB_WEBHOOK_SECRET=dev-webhook-secret` to `.dev.vars` (create if missing; never commit real secrets — `dev-webhook-secret` is a local-only value). Then:
  - `npm run dev` (background), wait for ready.
  - Replay the pr-merged fixture: compute the signature over the exact fixture bytes and `curl -s -X POST http://localhost:8787/webhook/github -H "X-GitHub-Event: pull_request" -H "X-Hub-Signature-256: sha256=<hex>" --data-binary @test/fixtures/gh-pr-merged.json` → expect `{"ok":true,"captured":1,…}`; re-POST → `captured:0`.
  - Tampered signature → 401.
  - If a GitHub token is available (`gh auth token`), run `node scripts/backfill-events.mjs` against dev and record the counts; if no token is available, note it in the final report — the fixture replay above still satisfies "replayed sample delivery" and the script is exercised by pointing REPO at a fixture-driven dry run flag `--dry` that prints the deliveries it WOULD post.
- [ ] **Step 3: Commit** — `feat(scripts): webhook backfill — synthesizes signed deliveries from GitHub REST`

---

# PHASE 1 — Stop the inflow (breaks no live reader)

### Task 9: Narrow the contract; retire `propose_milestone` + `set_focus` MCP tools

**Files:**
- Modify: `shared/contract.ts` (IngestPayload: drop `milestone_proposals` and `focus` arms; KEEP the `MilestoneProposal` and `FocusUpdate` schemas/exports — the gate fns and triage-assign still use them)
- Modify: `src/consumer.ts` (drop the milestones/focus loops + their `IngestResult` fields; KEEP `ingestMilestoneProposal` and `ingestFocusUpdate` functions)
- Modify: `src/mcp.ts` (delete the `propose_milestone` and `set_focus` tool registrations + now-unused imports)
- Modify tests: `test/record-session.mcp.test.ts`, `test/ingest.route.test.ts`, `test/consumer.reconcile.test.ts`, `test/roadmap.test.ts`, `test/mcp-writes.gated.test.ts`, `test/dashboard-*.test.ts` (only where they build payloads with the dropped arms or call the dropped tools — READ each first; gate-fn tests that call `ingestMilestoneProposal` DIRECTLY stay, they assert Phase-2-deferred behavior that must keep working for triage-assign)
- Test: extend `test/ingest.route.test.ts` + `test/record-session.mcp.test.ts` with narrowing assertions

**Interfaces:**
- Consumes: everything as of Task 8.
- Produces: `IngestPayload` = `{ session, feed_entries, doc_proposals, adr_drafts, needs_triage, events }`; `IngestResult` loses `milestones` and `focus`; MCP tool surface loses `propose_milestone`/`set_focus`.

- [ ] **Step 1: Failing behavioral tests first.**
  - `/ingest` narrowing: POST a payload that still carries a `milestone_proposals` array and a `focus` object → `200` (zod strips unknown keys), AND `milestone_proposals` table row-count is 0 AND `focus` table row-count is 0. This test fails before the change (the arms currently write).
  - MCP narrowing: `client.callTool({name:"propose_milestone",…})` → the SDK returns an error result (tool not found); same for `set_focus`. Assert via `isError`/rejection, and additionally `tools/list` does not contain them.
- [ ] **Step 2: Verify both fail** against current code.
- [ ] **Step 3: Apply the contract + consumer + mcp changes.** Keep the enumeration comment in `consume()` accurate (now feed → docs → adrs → triage → events). NOTE the replay-index shift is acceptable: old sessions' ledgers only ever replay identical old payloads, which no longer parse the dropped arms — they replay to the same indices for the arms that remain ONLY if enumeration order for remaining types is unchanged, which it is (feed, docs, adrs, triage keep their relative order; events stays last).
- [ ] **Step 4: Repair the suite.** Update payload literals; delete only assertions about the removed arms (e.g. `test/roadmap.test.ts` "consume() funnels proposals through the same gate" → REPLACE with the narrowing assertion; direct `ingestMilestoneProposal` gate tests stay). `test/focus-write.test.ts` / `test/focus-contract.test.ts` still pass untouched (gate fn + schema remain until Phase 4).
- [ ] **Step 5: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(contract)!: narrow IngestPayload — drop milestone_proposals/focus arms; retire propose_milestone/set_focus MCP tools`

---

### Task 10: Alter the `record-session` and `canopy` skills

**Files:**
- Modify: `plugins/canopy/skills/record-session/SKILL.md`
- Modify: `plugins/canopy/skills/canopy/SKILL.md`
- Modify: `plugins/canopy/skills/canopy/references/querying.md`

**Interfaces:** none (prose), but MUST match the Task 9 contract and the Task 6/7 tool surface exactly.

- [ ] **Step 1: record-session.** Remove the Milestone bullet (line 81) and the Focus bullet (lines 82-83) from step 4; remove `"milestone_proposals"` and `"focus"` lines from the step-5 JSONC payload example; add `needs_triage` to the example (it was already missing vs the contract); scan the whole file for any other milestone/focus mention (Hard rules line 119 keeps "Never mark 'done', never promote / ratify / complete" — still true). Keep feed/doc/ADR/read-before-write/single-call flow untouched.
- [ ] **Step 2: canopy skill.** Reading map: rewrite the `get_roadmap` line to the plan model ("the roadmap plan — admin-authored narrative + milestones with cached, event-derived progress; no live GitHub"), ADD `get_my_work` ("your captured-event My Work projection: summarized recent PRs + open assigned issues") and `get_events`. Writing map: drop `propose_milestone` and `set_focus`; note the plan is admin-authored via the `update-plan` skill (direct, versioned, promote-class — agents do not propose milestones). Update `references/querying.md:56` (`get_roadmap` row) the same way.
- [ ] **Step 3: Verify** — `grep -rn "propose_milestone\|set_focus\|focus" plugins/canopy/skills/` returns no stale instruction (the word "focus" may legitimately survive in unrelated prose — read matches, don't blind-delete).
- [ ] **Step 4: Commit** — `docs(skills): record-session/canopy stop emitting milestones+focus; read map moves to the plan model`

---

# PHASE 3 — Flip render surfaces to D1

### Task 11: Roadmap flip — `GET /roadmap`, MCP `get_roadmap` read the plan store

**Files:**
- Modify: `src/tools/roadmap.ts` — REWRITE: delete `list_roadmap` + `devProgress` + `MilestoneWithProgress` (get_plan replaces them); file becomes a thin re-export or is DELETED with imports updated (prefer delete; `fetchMilestoneProgress` already lives in progress.ts)
- Modify: `src/routes.ts:180-185` (`GET /roadmap` → `c.json(await get_plan(c.env.DB))`; drop `getStoredToken` import/use here)
- Modify: `src/mcp.ts:116-121` (`get_roadmap` → `runTool(() => get_plan(env.DB))`; drop `getStoredToken` import; update description: "Read the roadmap plan: admin narrative + milestones in target-date order with cached progress (no live GitHub).")
- Modify: `test/roadmap.test.ts` (list_roadmap/dev-synthesize tests → get_plan-based route tests)
- Test: extend `test/plan.test.ts`/`test/roadmap.test.ts`

**Interfaces:**
- Consumes: `get_plan` (Task 7).
- Produces: `GET /roadmap` body = `PlanView` (`{ narrative, version, updated_at, updated_by, milestones: [{ …MilestoneRow, progress: {closed,total,computed_at}|null }] }`). NOTE the response is no longer `{ milestones: … }` — the web layer is updated in Task 14/15 IN THE SAME PHASE; land Tasks 11-15 before considering Phase 3 verified.

- [ ] **Step 1: Failing tests** — route test: seed a milestone + `upsertProgress` + `write_plan` narrative; `GET /roadmap` (sealed cookie) → 200 with narrative + milestone + cached progress; NO fetch stub configured anywhere (proves no GitHub on the path — add a `fetchImpl`-style tripwire is impossible here, so instead assert shape + the absence of token plumbing by construction). MCP test: `get_roadmap` returns the same PlanView.
- [ ] **Step 2-3: fail → implement.** Delete `src/tools/roadmap.ts` (its only remaining consumers were routes/mcp); `web/src/api.ts` type imports from it must be adjusted in Task 14/15 (typecheck will enforce).
- [ ] **Step 4: Verify** — `npm test` (web typecheck may fail until Task 14/15 — acceptable mid-phase; run `tsc -p tsconfig.worker.json` for the worker half now).
- [ ] **Step 5: Commit** — `feat(roadmap)!: /roadmap + get_roadmap read the plan store — no live GitHub, no per-user token`

---

### Task 12: Dashboard flip — `GET /me/dashboard` returns the two-list My Work

**Files:**
- Modify: `shared/dashboard.ts` — REWRITE to the new DTO (keep the file as the DTO seam):

```ts
// DTOs for the personal "My Work" dashboard: two explicitly separate lists off
// the captured-event stream (shared/ so worker and web agree).
import type { MyWorkPr, MyWorkTodo } from "./mywork";   // OR inline the types here — see step 3
export interface DashboardData {
  person: string | null;            // identity-mapped name; null if unmapped
  previousActivity: MyWorkPr[];     // summarized merged/closed PRs, last 14 days
  todo: MyWorkTodo[];               // open issues assigned to the person
  degraded: boolean;                // D1 projection unavailable
}
```

  (`MyWorkPr`/`MyWorkTodo` MOVE from `src/tools/mywork.ts` into `shared/dashboard.ts` so web/ can import them — `src/tools/mywork.ts` re-imports from `@shared/dashboard`.)
- Delete: `src/tools/dashboard.ts` (parseRoadmapForPerson, listAssignedIssues, fetchRoadmapMarkdown, getMyDashboard — all of it), `src/people.ts`
- Modify: `src/routes.ts:187-209` — `/me/dashboard` calls `getMyWork(c.env.DB, login)` and returns `DashboardData` (`{ …myWork }` maps 1:1); keep the try/catch absolute backstop returning `{ person:null, previousActivity:[], todo:[], degraded:true }`; drop the `getStoredToken`/`CONTENT_REPO` plumbing.
- Modify: `src/env.ts` — remove `CONTENT_REPO`; `wrangler.toml` — remove `CONTENT_REPO` var.
- Delete tests: `test/dashboard-parse.test.ts`, `test/dashboard-issues.test.ts`, `test/dashboard-aggregate.test.ts`, `test/people.test.ts` (behaviors removed).
- Rewrite: `test/dashboard-route.test.ts`, `test/dashboard-resilience.test.ts` against the new shape.

**Interfaces:**
- Consumes: `getMyWork` (Task 6).
- Produces: `GET /me/dashboard` → new `DashboardData`; `@shared/dashboard` exports `DashboardData`, `MyWorkPr`, `MyWorkTodo`.

- [ ] **Step 1: Failing tests** — rewrite `test/dashboard-route.test.ts`: seed events (merged PR for `AndresL230` + open assigned issue) + a stored summary; `GET /me/dashboard` with cookie → `{ person: "Andres", previousActivity: [pr with summary], todo: [issue], degraded: false }`; 401 without session; focus/roadmap fields ABSENT (`expect(body).not.toHaveProperty("focus")`).
- [ ] **Step 2-3: fail → implement** (moves, deletes, route rewrite).
- [ ] **Step 4: Verify** — `npm test && tsc -p tsconfig.worker.json` (worker green; web pending Tasks 13-15).
- [ ] **Step 5: Commit** — `feat(dashboard)!: /me/dashboard = two-list captured-event My Work; delete ROADMAP.md parser + live issue fetch + people.ts`

---

### Task 13: FTS — `query` learns the roadmap

**Files:**
- Create: `migrations/0013_roadmap_fts.sql`
- Modify: `shared/contract.ts` (QueryRequest/QueryPrimary/QueryPointer type enums += `"milestone"`), `src/tools/reads.ts` (query engine candidate pass + hydration), `src/mcp.ts` (query tool `types` enum), `src/routes.ts:60-78` (`/search` types parsing), `web/src/api.ts` (`QueryType` union += `"milestone"`), `web/src/render.ts:1055-1056` (`SEARCH_TYPE_ICON`/`SEARCH_TYPE_LABEL` gain a milestone entry — flag/target icon, label "Roadmap"), `src/tools/plan.ts`/`src/tools/writes.ts` if needed (no-op — triggers handle indexing)
- Modify: `test/fts-isolation.test.ts` (roadmap_fts cascades on truncation)
- Test: `test/query.roadmap.test.ts`

**Interfaces:**
- Consumes: `milestones`, `plan` tables; the 0008/0011 standalone-FTS + trigger pattern (follow it EXACTLY — delete-then-insert keyed triggers, `porter unicode61`, backfill at the end; document the d1-export caveat).
- Produces: virtual table `roadmap_fts(ref UNINDEXED, title, body)` where `ref` = `milestone:<id>` (title = milestone title; body = `description ∥ phase ∥ status`) or `plan` (title = 'Roadmap plan'; body = narrative). Triggers: milestones ai/au(title,description,phase,status)/ad; plan au(narrative). Query type `"milestone"`: FTS candidates from `roadmap_fts`, hydration → `QueryPrimary` with `type:"milestone"`, `id` = ref (`"milestone:3"` / `"plan"`), `authority:"live"` (plan writes are direct/live), `body` = description+phase+progress line for milestones (`Progress: 4/6 closed` appended from the cache at hydration) or the narrative for the plan row, `updated_at/by` from the row. Feed/decision behavior unchanged; `"milestone"` participates in the default types list.

- [ ] **Step 1: Failing test** — `test/query.roadmap.test.ts`: `write_plan` a narrative mentioning "vector search rollout" + a milestone titled "Vectorize GA"; `query(env.DB, { q: "vectorize", include_staged: true })` → a `milestone`-typed hit for the milestone; `query(… q:"vector search rollout")` → the plan hit carrying the narrative body; truncation cascade test in fts-isolation style.
- [ ] **Step 2-3: fail → migration + engine.** Follow `0008_fts.sql` trigger idiom verbatim (keyed delete-then-insert; CAST id AS TEXT for the ref key).
- [ ] **Step 4: Verify** — `npx vitest run test/query.roadmap.test.ts test/query.fts.test.ts test/fts-isolation.test.ts`; `npm test && npm run typecheck` (worker).
- [ ] **Step 5: Commit** — `feat(query): index plan + milestones into FTS — query stops being roadmap-blind`

---

### Task 14: Web — My Work screen rebuild (two lists, markdown summaries)

**Files:**
- Modify: `web/src/api.ts` (`getMyDashboard` return type = new `DashboardData`; `getRoadmap(): Promise<PlanView>` — import types from `@shared/dashboard` / define `PlanView` locally mirroring the worker; note web has its own tsconfig with the `@shared` alias)
- Modify: `web/src/render.ts` — REWRITE `myWorkView` (lines 1349-1427) + its helpers; DELETE `mwRoadmapRow` (1339-1347) and the focus/roadmap-phase headline block (1365-1390); keep `wrapMyWork`, `greetingFor`, `mwSection`, `MW_LABEL`
- Modify: `web/src/main.ts` (state field types; the mywork loader unchanged path-wise)
- Test: `test/render.mywork.test.ts` (new; pattern of `test/render.triage.test.ts`)

**Interfaces:**
- Consumes: `DashboardData` (Task 12) — `{ person, previousActivity, todo, degraded }`.
- Produces: exported testable pure renderers so tests stay DOM-free (mirror `renderProposalContent`'s injected-markdown pattern):

```ts
export function prActivityCard(pr: MyWorkPr, markdownFn: (body: string) => string): string
export function todoCard(t: MyWorkTodo): string
```

  `myWorkView` composes: hero greeting (existing) → `mwSection("Previous activity — last 14 days", …)` list of `prActivityCard`s → `mwSection("To-do", …)` list of `todoCard`s. `prActivityCard`: card (existing card idiom: `border:1px solid var(--border);border-radius:13px;padding:…`) with `#<number>` mono link to `pr.url`, title, `relTime(occurredAt)`, MERGED (green) / CLOSED (fg-40) chip, and the summary rendered via `<div class="cnpy-md" style="font-size:13.5px;color:var(--fg-70)">${markdownFn(pr.summary)}</div>` when present (raw-text fallback: `linkifyRefs`). `todoCard`: reuse the existing assigned-issue card markup verbatim from the old block (render.ts 1394-1412 idiom — priority amber mono, `#number`, ellipsized title, ≤3 labels) — it renders from issue metadata, NO markdown. Empty states via `notice()`/dashed-card hints; `degraded:true` → the existing degraded hint style. NO focus, NO roadmap phases, NO feed section in this view.
- `myWorkView` passes the real `renderMarkdown` (already imported in render.ts) as `markdownFn`.

- [ ] **Step 1: Failing render tests** — with a `mockMd` fn (pattern `test/render.triage.test.ts:29`): `prActivityCard` embeds `mock-md` output + MERGED chip color token; `todoCard` shows priority/labels and NO markdown wrapper; XSS: a `<script>` PR title is escaped; full `render()` of a state with mywork data contains both section labels and does NOT contain "Working on now" (focus headline gone — behavioral revert guard).
- [ ] **Step 2-4: fail → implement → verify** `npx vitest run test/render.mywork.test.ts && npm run typecheck && npm run build:web`.
- [ ] **Step 5: Commit** — `feat(web): My Work = previous-activity (markdown summaries) + to-do, off captured events`

---

### Task 15: Web — Roadmap screen rebuild (admin narrative + cached progress)

**Files:**
- Modify: `web/src/api.ts` (`getRoadmap` per Task 14), `web/src/main.ts` (roadmap loader stores `{narrative, milestones}`; add `roadmapNarrativeText: string` to state or store the PlanView in `state.roadmap`), `web/src/render.ts` (`roadmapView`/`roadmapDigest`/`roadmapNarrative`/`roadmapEnriched` — keep `roadmapEnriched` UNCHANGED: the new `progress` still carries `{closed,total}`)
- Test: `test/render.roadmap.test.ts` (new)

**Interfaces:**
- Consumes: `PlanView` from `GET /roadmap`.
- Produces: Narrative tab (`roadmapDigest`) now opens with the ADMIN-AUTHORED narrative rendered as markdown — exported testable helper:

```ts
export function planNarrativeBlock(narrative: string, markdownFn: (body: string) => string): string
```

  (`<div class="cnpy-md">…` inside the existing digest card idiom; empty narrative → dashed hint "No plan narrative yet — write one with the update-plan skill".) Keep the existing milestone spotlight + "Recent happenings" sections (they read milestones + feed — both still live). Timeline tab (`roadmapNarrative` fn) unchanged except milestones now arrive from the PlanView and each may carry `phase` — show phase as the small mono suffix where the window used to appear if present. Progress bars: UNCHANGED markup (cache supplies closed/total).
- Confirm-done wiring: the "Confirm done" button (`data-act="confirmMilestone"` → `POST /milestones/:id/complete`) stays — completion remains admin/human.

- [ ] **Step 1: Failing tests** — `planNarrativeBlock` renders through the injected markdown fn; empty → hint; `render()` with a loaded PlanView shows narrative in the narrative tab and progress `4/6 closed` in the timeline tab.
- [ ] **Step 2-4: fail → implement → verify** `npx vitest run test/render.roadmap.test.ts && npm test && npm run typecheck && npm run build:web`.
- [ ] **Step 5: Verify no-GitHub invariant repo-wide:** `grep -rn "api.github.com" src/ | grep -v progress.ts` → EMPTY (only the off-render recompute path remains); `grep -rn "getStoredToken" src/` → only `auth/github.ts` definition (deleted next phase).
- [ ] **Step 6: Commit** — `feat(web): Roadmap renders the admin plan narrative + cached progress`

---

# PHASE 4 — Final focus and token drop

### Task 16: Focus teardown

**Files:**
- Create: `migrations/0014_drop_focus.sql` — `DROP TABLE focus;`
- Modify: `shared/contract.ts` (delete `FocusUpdate` schema+type), `shared/rows.ts` (delete `FocusRow`; drop `"focus"` from `ProcessedItemRow.item_type`), `shared/dashboard.ts` (already clean from Task 12 — verify), `src/consumer.ts` (delete `ingestFocusUpdate`), `src/tools/writes.ts` (delete `set_focus`), `src/tools/reads.ts` (delete `get_focus`, `FocusRow` import), `test/apply-migrations.ts` + `test/fts-isolation.test.ts` (remove `DELETE FROM focus;` — it would now ERROR)
- Delete tests: `test/focus-contract.test.ts`, `test/focus-write.test.ts`
- Test: extend `test/events-schema.test.ts` with a revert guard

- [ ] **Step 1: Verify current state before removing** — `grep -rn "focus" src/ shared/ web/src/ test/ --include='*.ts'` and confirm the only remaining references are the ones listed above (Phase 3 already removed dashboard/render use). Any extra hit → handle it, don't skip it.
- [ ] **Step 2: Failing revert-guard test** — in `test/events-schema.test.ts`: `SELECT name FROM sqlite_master WHERE type='table' AND name='focus'` → empty (fails before the migration exists).
- [ ] **Step 3: Apply** migration + deletions; fix the truncation lists.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`; `grep -rn "focus" src/ shared/` → no functional hits.
- [ ] **Step 5: Commit** — `feat(db)!: drop focus — table, contract, gate arm, writers, readers, tests`

---

### Task 17: Per-user GitHub token retirement

**Files:**
- Create: `migrations/0015_drop_user_token.sql` — `ALTER TABLE users DROP COLUMN github_token;`
- Modify: `src/auth/github.ts` (delete `storeToken`, `getStoredToken`), `src/auth/routes.ts:62-66` (callback stops sealing/storing: drop `encryptSecret` import + `github_token` from the upsert columns), `shared/rows.ts` (`UserRow` drops `github_token`), `src/auth/crypto.ts` (delete `encryptSecret`/`decryptSecret` IF now unused — verify with grep first), `test/auth-crypto.test.ts`/`test/roadmap.test.ts` (drop the sealing round-trip + store/retrieve tests)
- Test: extend an auth test with a revert guard

- [ ] **Step 1: Verify current state** — `grep -rn "github_token\|getStoredToken\|storeToken\|encryptSecret\|decryptSecret" src/ shared/ test/` — after Tasks 11/12 the ONLY consumers should be auth/github.ts, auth/routes.ts, rows.ts, and tests. The scheduled recompute uses `GITHUB_SERVICE_TOKEN` (Task 5), so the column can go (spec decision 10).
- [ ] **Step 2: Failing revert guard** — `SELECT * FROM pragma_table_info('users') WHERE name='github_token'` → empty; and the OAuth callback test (`test/auth-routes.test.ts` — read it first) still passes with the narrowed upsert.
- [ ] **Step 3: Apply.** If `encryptSecret`/`decryptSecret` have zero remaining consumers, delete them + their tests (behavioral posture: no dead surface); `hmacSeal`/`hmacUnseal`/PKCE stay (cookies + OAuth).
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(auth)!: retire per-user github_token — service token owns the only GitHub read`

---

### Task 18: New skills — `read-plan`, `update-plan`, `my-work` (+ load-context hook)

**Files:**
- Create: `plugins/canopy/skills/read-plan/SKILL.md`, `plugins/canopy/skills/update-plan/SKILL.md`, `plugins/canopy/skills/my-work/SKILL.md`
- Create symlinks: `.claude/skills/read-plan`, `.claude/skills/update-plan`, `.claude/skills/my-work` → the plugin dirs (match the existing symlink pattern: `ln -s ../../plugins/canopy/skills/<name> .claude/skills/<name>`)
- Modify: `plugins/canopy/skills/load-context/SKILL.md` (orientation also pulls `get_my_work`)

**Content requirements:**
- `read-plan` (ADMIN, read-only): frontmatter `allowed-tools: mcp__canopy__get_roadmap, mcp__canopy__get_events, mcp__canopy__query`; procedure: `get_roadmap` (narrative + milestones + cached progress) then `get_events` (recent captured activity) so the admin reshapes against reality; explicitly never writes.
- `update-plan` (ADMIN, write): `allowed-tools: mcp__canopy__get_roadmap, mcp__canopy__update_plan`; procedure: ALWAYS `get_roadmap` first (read-before-write), show the admin the diff of intended changes, then ONE `update_plan` call; document that this is the direct promote-class path, versioned non-destructively; `status:'done'` is set here and only here (or via the web Confirm-done button); milestones omitted from the call are untouched.
- `my-work` (anyone, read-only, thin): `allowed-tools: mcp__canopy__get_my_work`; one call, render the two lists, no writes; note previous-activity is 14-day-windowed and summaries are worker-generated projections (raw events are truth).
- `load-context` — add a step: when orienting, ALSO call `get_my_work` (if available) so session start includes the person's own open work; keep the skill read-only.
- Frontmatter style: copy tone/shape from the existing skills (name, description with trigger phrases, `disable-model-invocation: true` for `update-plan` — a write skill must be explicit-only like record-session).

- [ ] **Step 1: Write the three skills + symlinks + load-context edit.**
- [ ] **Step 2: Verify** — each SKILL.md frontmatter parses (matches existing format), symlinks resolve (`ls -l .claude/skills/`), tool names exactly match the MCP registrations (`grep -n "server.tool" src/mcp.ts`).
- [ ] **Step 3: Commit** — `feat(skills): read-plan/update-plan/my-work; load-context orients with get_my_work`

---

### Task 19: Docs sync + full verification + whole-branch review

**Files:**
- Modify: `CLAUDE.md` (Working memory skill list; Layout — new files/migrations; Core invariant — restate per decision 1: "ingested content is gated; authored (plan) and computed (progress, summary) writes are direct"; the events arm + webhook auth class; Read side — query types incl. milestone; Roadmap section — plan store + progress cache + scheduled backstop + service token; Auth — remove the sealed-org-token sentence; Env — new secrets `GITHUB_WEBHOOK_SECRET`, `GITHUB_SERVICE_TOKEN`, AI binding, `[triggers]`; remove CONTENT_REPO)
- Verify only (no code): the full suite, invariants, and a final whole-branch review.

- [ ] **Step 1:** Update CLAUDE.md faithfully to the shipped state (verify each claim against the code as you write it).
- [ ] **Step 2: Full verification** — `npm test` (all green, paste tail), `npm run typecheck`, `npm run build:web`. Invariant greps: `grep -rn "api.github.com" src/` → only `src/tools/progress.ts`; `grep -rn "getStoredToken\|github_token" src/ shared/` → empty; `grep -rn "set_focus\|propose_milestone" src/` → empty (writes.ts triage-assign milestone path uses `ingestMilestoneProposal`, which stays).
- [ ] **Step 3:** One whole-branch code review (single reviewer pass over `git diff main...HEAD`), fix findings, re-run the suite.
- [ ] **Step 4: Commit** — `docs: sync CLAUDE.md to the roadmap/my-work rebuild`

---

## Execution notes for the controller

- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → (9 ∥ 10) → 11 → 12 → 13 → (14 ∥ nothing — 14 and 15 both edit render.ts, run sequentially) → 15 → (16 ∥ 18) → 17 → 19. Tasks marked ∥ touch disjoint files and may run as parallel subagents.
- Per-task review is controller-side inline (read the diff after each subagent); ONE final whole-branch review at Task 19 (user preference).
- Prod ops NOT performed by this build (report to the user at the end): `wrangler secret put GITHUB_WEBHOOK_SECRET` + `GITHUB_SERVICE_TOKEN`, `npm run db:migrate:remote` (0012-0015 — remember: deploy does NOT apply migrations), configuring the GitHub webhook (repo → Settings → Webhooks → `https://canopy.saplinglearn.com/webhook/github`, content-type json, secret, events: pull requests + issues), and running `scripts/backfill-events.mjs` against prod.
