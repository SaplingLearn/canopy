# Local Seed Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a single local dataset that lights up every Canopy surface (My Work, Feed, Docs, Roadmap, Triage, Search) against the current schema, loaded by one command through the existing `DEV_LOGIN` local-mode toggle.

**Architecture:** JSON fixture files under `fixtures/dev/` are the source of truth. A pure builder (`scripts/seed/build.mjs`) turns them into escaped SQL statements; a CLI loader (`scripts/seed-dev.mjs`) resets local D1 and applies them via `wrangler d1 execute --local` (refusing `--remote`). The app's D1 read paths are unchanged — FTS5 triggers auto-index on insert, so Search needs no direct seeding. A Vitest guard runs the same builder against the Miniflare D1 harness and asserts every surface returns data.

**Tech Stack:** Node ESM (`.mjs`) dev scripts, Wrangler D1 CLI, Vitest + `cloudflare:test` Miniflare D1, TypeScript worker read paths.

## Global Constraints

- Dev identity is `AndresL230` — a migration-seeded `people` row and the `ADMIN_LOGINS` value. All seeded PR/issue events carry `subject_login: "AndresL230"`; `.dev.vars` must set `DEV_LOGIN=AndresL230`.
- Controlled vocabulary is fixed: sections ∈ `reference | context | decisions | needs-triage`; tags ∈ `auth | architecture | infra | api | ui | data` (`shared/vocabulary.ts`). Fixtures MUST use only these.
- The reset statement list MUST mirror the truncation in `test/apply-migrations.ts:18` verbatim (same FK-safe order, same `people` re-seed). It lives in exactly one place: `scripts/seed/reset.mjs`.
- The loader only ever targets LOCAL D1. It MUST refuse `--remote`. No fixtures or seed code are imported by the worker (`src/`).
- `events.raw` MUST match the shape `src/tools/mywork.ts` parses: PR → `{ pr: { number, title, body, html_url, merged, merged_at, closed_at, user:{login}, milestone } }`; issue → `{ action, issue: { number, title, body, html_url, state, updated_at, user:{login}, assignees:[{login}], labels:[string], milestone } }`.

## File Structure

- Create `scripts/seed/reset.mjs` — canonical reset statement array (mirrors `test/apply-migrations.ts`).
- Create `scripts/seed/build.mjs` — pure `buildSeedStatements(fx)` + `targetsRemote(argv)`; no fs, no network, no worker imports.
- Create `scripts/seed-dev.mjs` — CLI: refuse `--remote`, read fixtures, build SQL, write temp `.sql`, run wrangler against local D1.
- Create `fixtures/dev/docs.json`, `feed.json`, `adrs.json`, `triage.json`, `roadmap.json`, `events.json`, `identity.json` — the dataset.
- Create `test/seed-build.test.ts` — unit test for the builder's escaping/coverage.
- Create `test/seed-coverage.test.ts` — the guard: seed Miniflare D1, assert every surface non-empty.
- Modify `package.json` — add `"seed"` script.
- Modify `.dev.vars` — set `DEV_LOGIN=AndresL230` (git-ignored; local only).

---

## Task 1: Seed builder & canonical reset

Pure, dependency-free module that turns fixture objects into escaped SQL. Unit-tested with tiny inline fixtures — no real files yet.

**Files:**
- Create: `scripts/seed/reset.mjs`
- Create: `scripts/seed/build.mjs`
- Test: `test/seed-build.test.ts`

**Interfaces:**
- Produces: `buildSeedStatements(fx) → string[]` where `fx = { docs, feed, adrs, triage, roadmap, events, identity }` (each the parsed JSON of the matching fixture file, any key optional). Returns fully-escaped, standalone SQL statements (no trailing `;`), reset statements first.
- Produces: `targetsRemote(argv: string[]) → boolean` — true iff `--remote` is present.
- Produces: `RESET_STATEMENTS: string[]` from `reset.mjs`.

- [ ] **Step 1: Write `scripts/seed/reset.mjs`**

```js
// Canonical local-D1 reset. MUST mirror the beforeEach truncation in
// test/apply-migrations.ts (same FK-safe delete order, same people re-seed).
// If a migration adds a table to that truncation, add it here too.
export const RESET_STATEMENTS = [
  "DELETE FROM processed_items",
  "DELETE FROM pr_summaries",
  "DELETE FROM issue_summaries",
  "DELETE FROM events",
  "DELETE FROM milestone_progress",
  "DELETE FROM plan_versions",
  "UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL",
  "DELETE FROM milestone_proposals",
  "DELETE FROM milestones",
  "DELETE FROM doc_versions",
  "DELETE FROM docs",
  "DELETE FROM feed",
  "DELETE FROM entry_tags",
  "DELETE FROM adrs",
  "DELETE FROM needs_triage",
  "DELETE FROM identity_tasks",
  "DELETE FROM people",
  "INSERT INTO people (login, person) VALUES ('AndresL230', 'Andres'), ('Jose-Gael-Cruz-Lopez', 'Jose'), ('lpcooper-arch', 'Luke'), ('Darkest-Teddy', 'Jack')",
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM users",
];
```

- [ ] **Step 2: Write `scripts/seed/build.mjs`**

```js
import { RESET_STATEMENTS } from "./reset.mjs";

// SQL string literal: wrap in single quotes, double any embedded quote. NULL for
// null/undefined. JSON.stringify guarantees no literal newlines in embedded JSON.
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const jsonLit = (obj) => (obj === null || obj === undefined ? "NULL" : q(JSON.stringify(obj)));

/** True iff the loader was asked to touch remote D1 — the loader must refuse. */
export const targetsRemote = (argv) => argv.includes("--remote");

/**
 * Turn parsed fixture objects into standalone, escaped SQL statements (no
 * trailing ";"), reset statements first. FK-safe ordering: events before
 * pr_summaries, milestones before milestone_progress.
 */
export function buildSeedStatements(fx) {
  const s = [...RESET_STATEMENTS];

  for (const d of fx.docs?.docs ?? []) {
    s.push(
      `INSERT INTO docs (slug, section, space, title, body, current_version, updated_at, updated_by) VALUES (` +
        `${q(d.slug)}, ${q(d.section)}, ${q(d.space ?? "canopy")}, ${q(d.title)}, ${q(d.body)}, ${num(d.current_version)}, ${q(d.updated_at)}, ${q(d.updated_by)})`
    );
    for (const v of d.versions ?? []) {
      s.push(
        `INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by, change_kind, base_version, low_confidence) VALUES (` +
          `${q(d.slug)}, ${num(v.version)}, ${q(v.body)}, ${q(v.summary)}, ${q(v.status)}, ${q(v.confidence)}, ${q(v.created_at)}, ${q(v.created_by)}, ${q(v.change_kind)}, ${num(v.base_version)}, ${num(v.low_confidence ?? 0)})`
      );
    }
  }

  for (const f of fx.feed?.feed ?? []) {
    s.push(
      `INSERT INTO feed (id, author, summary, body, artifacts, created_at) VALUES (` +
        `${num(f.id)}, ${q(f.author)}, ${q(f.summary)}, ${q(f.body)}, ${jsonLit(f.artifacts)}, ${q(f.created_at)})`
    );
    for (const t of f.tags ?? []) {
      s.push(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES (${q(t)}, 'feed', ${q(String(f.id))})`);
    }
  }

  for (const a of fx.adrs?.adrs ?? []) {
    s.push(
      `INSERT INTO adrs (id, title, context, decision, rationale, status, confidence, created_at, created_by) VALUES (` +
        `${num(a.id)}, ${q(a.title)}, ${q(a.context)}, ${q(a.decision)}, ${q(a.rationale)}, ${q(a.status)}, ${q(a.confidence)}, ${q(a.created_at)}, ${q(a.created_by)})`
    );
  }

  for (const t of fx.triage?.needs_triage ?? []) {
    s.push(
      `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at) VALUES (` +
        `${q(t.raw)}, ${q(t.reason)}, ${q(t.source_author)}, ${num(t.resolved ?? 0)}, ${q(t.created_at)})`
    );
  }

  for (const m of fx.triage?.milestone_proposals ?? []) {
    s.push(
      `INSERT INTO milestone_proposals (title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by) VALUES (` +
        `${q(m.title)}, ${q(m.target_date)}, ${q(m.status)}, ${q(m.github_ref)}, ${q(m.change_summary)}, ${q(m.confidence)}, ${q(m.staged_status ?? "staged")}, ${q(m.created_at)}, ${q(m.created_by)})`
    );
  }

  const rm = fx.roadmap;
  if (rm) {
    s.push(
      `UPDATE plan SET narrative = ${q(rm.narrative)}, current_version = ${num(rm.version)}, updated_at = ${q(rm.updated_at)}, updated_by = ${q(rm.updated_by)} WHERE id = 1`
    );
    s.push(
      `INSERT INTO plan_versions (version, narrative, milestones_json, created_at, created_by) VALUES (` +
        `${num(rm.version)}, ${q(rm.narrative)}, ${jsonLit(rm.milestones ?? [])}, ${q(rm.updated_at)}, ${q(rm.updated_by)})`
    );
    for (const m of rm.milestones ?? []) {
      s.push(
        `INSERT INTO milestones (id, title, description, phase, target_date, status, github_ref, created_at, created_by, updated_at) VALUES (` +
          `${num(m.id)}, ${q(m.title)}, ${q(m.description)}, ${q(m.phase)}, ${q(m.target_date)}, ${q(m.status)}, ${q(m.github_ref)}, ${q(m.created_at)}, ${q(m.created_by)}, ${q(m.updated_at)})`
      );
      if (m.progress) {
        s.push(
          `INSERT INTO milestone_progress (milestone_id, closed, total, source, computed_at) VALUES (` +
            `${num(m.id)}, ${num(m.progress.closed)}, ${num(m.progress.total)}, ${q(m.progress.source ?? "recompute")}, ${q(m.progress.computed_at)})`
        );
      }
    }
  }

  for (const e of fx.events?.events ?? []) {
    s.push(
      `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (` +
        `${q(e.semantic_key)}, ${q(e.event_type)}, ${num(e.ref_number)}, ${q(e.subject_login)}, ${jsonLit(e.raw)}, ${q(e.provenance ?? "backfill")}, ${q(e.occurred_at)}, ${q(e.recorded_at)}, ${q(e.recorded_by ?? "github-webhook")})`
    );
    if (e.pr_summary) {
      s.push(
        `INSERT INTO pr_summaries (semantic_key, pr_number, summary, model, created_at) VALUES (` +
          `${q(e.semantic_key)}, ${num(e.ref_number)}, ${q(e.pr_summary)}, 'excerpt', ${q(e.recorded_at)})`
      );
    }
    if (e.issue_summary) {
      s.push(
        `INSERT INTO issue_summaries (issue_number, summary, model, created_at) VALUES (` +
          `${num(e.ref_number)}, ${q(e.issue_summary)}, 'excerpt', ${q(e.recorded_at)})`
      );
    }
  }

  for (const t of fx.identity?.identity_tasks ?? []) {
    s.push(
      `INSERT INTO identity_tasks (login, first_seen, status, resolved_at, resolved_by) VALUES (` +
        `${q(t.login)}, ${q(t.first_seen)}, ${q(t.status ?? "pending")}, ${q(t.resolved_at)}, ${q(t.resolved_by)})`
    );
  }

  return s;
}
```

- [ ] **Step 3: Write the failing test `test/seed-build.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildSeedStatements, targetsRemote } from "../scripts/seed/build.mjs";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

describe("buildSeedStatements", () => {
  it("prepends the canonical reset, in order", () => {
    const out = buildSeedStatements({});
    expect(out.slice(0, RESET_STATEMENTS.length)).toEqual(RESET_STATEMENTS);
  });

  it("escapes single quotes in values", () => {
    const out = buildSeedStatements({ docs: { docs: [{ slug: "s", section: "reference", title: "O'Hara", body: "b", current_version: 1, updated_at: "t", updated_by: "u", versions: [] }] } });
    const insert = out.find((s) => s.startsWith("INSERT INTO docs"));
    expect(insert).toContain("'O''Hara'");
  });

  it("serializes event raw as a JSON string literal with no literal newline", () => {
    const out = buildSeedStatements({ events: { events: [{ semantic_key: "k", event_type: "pr_merged", ref_number: 1, subject_login: "AndresL230", provenance: "backfill", occurred_at: "t", recorded_at: "t", raw: { pr: { body: "line1\nline2" } } }] } });
    const insert = out.find((s) => s.startsWith("INSERT INTO events"));
    expect(insert).toContain("line1\\nline2");
    expect(insert.includes("\n")).toBe(false);
  });

  it("emits a milestone_progress insert only when progress is present", () => {
    const withP = buildSeedStatements({ roadmap: { narrative: "n", version: 1, milestones: [{ id: 1, title: "m", target_date: "2026-01-01", status: "done", progress: { closed: 2, total: 2, computed_at: "t" } }] } });
    const without = buildSeedStatements({ roadmap: { narrative: "n", version: 1, milestones: [{ id: 2, title: "m2", target_date: "2026-01-01", status: "upcoming" }] } });
    expect(withP.some((s) => s.startsWith("INSERT INTO milestone_progress"))).toBe(true);
    expect(without.some((s) => s.startsWith("INSERT INTO milestone_progress"))).toBe(false);
  });

  it("targetsRemote detects the --remote flag", () => {
    expect(targetsRemote(["--remote"])).toBe(true);
    expect(targetsRemote(["--local"])).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test — expect FAIL (module not found), then PASS after Steps 1–2**

Run: `npx vitest run test/seed-build.test.ts`
Expected: PASS (all 5 assertions). If run before Steps 1–2, FAIL with a module-resolution error.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed/reset.mjs scripts/seed/build.mjs test/seed-build.test.ts
git commit -m "feat(seed): pure SQL builder + canonical reset for local seed"
```

---

## Task 2: Dev fixtures + coverage guard

Author the seven fixture files, then a test that runs the real builder against the Miniflare D1 and asserts every surface returns data. This is the load-bearing task — the green test proves the seed lights up My Work, Roadmap, Search, Triage, and Feed.

**Files:**
- Create: `fixtures/dev/docs.json`, `fixtures/dev/feed.json`, `fixtures/dev/adrs.json`, `fixtures/dev/triage.json`, `fixtures/dev/roadmap.json`, `fixtures/dev/events.json`, `fixtures/dev/identity.json`
- Test: `test/seed-coverage.test.ts`

**Interfaces:**
- Consumes: `buildSeedStatements` (Task 1); worker read paths `getMyWork`, `get_plan`, `query`, `get_feed`, `list_proposals`, `list_needs_triage`, `list_adrs`, `list_identity_tasks`.

- [ ] **Step 1: Write `fixtures/dev/docs.json`**

```json
{
  "docs": [
    {
      "slug": "mcp-server", "section": "reference", "space": "canopy",
      "title": "MCP Server", "current_version": 2,
      "updated_at": "2026-06-23T00:00:00Z", "updated_by": "meilin",
      "body": "The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post session output through a typed contract. Every request carries a bearer token, compared in constant time. Token rotation is tracked in #142.",
      "versions": [
        { "version": 1, "body": "v1 body — initial page.", "summary": "Initial page", "status": "promoted", "confidence": "high", "created_at": "2026-04-01T00:00:00Z", "created_by": "devraj" },
        { "version": 2, "body": "The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post session output through a typed contract. Every request carries a bearer token, compared in constant time. Token rotation is tracked in #142.", "summary": "Documented the typed contract", "status": "promoted", "confidence": "high", "created_at": "2026-06-23T00:00:00Z", "created_by": "meilin" },
        { "version": 3, "body": "The MCP server is the only write path. Tokens are compared in constant time. Rotation: revoke and re-mint from Settings.", "summary": "Clarify token rotation", "status": "staged", "confidence": "high", "created_at": "2026-06-24T00:00:00Z", "created_by": "meilin", "change_kind": "edit", "base_version": 2 }
      ]
    },
    {
      "slug": "product-overview", "section": "context", "space": "canopy",
      "title": "Product Overview", "current_version": 1,
      "updated_at": "2026-06-10T00:00:00Z", "updated_by": "sanaok",
      "body": "Canopy is the shared source of truth and working memory for Sapling, a four-person software team.",
      "versions": [
        { "version": 1, "body": "Canopy is the shared source of truth and working memory for Sapling, a four-person software team.", "summary": "Initial page", "status": "promoted", "confidence": "high", "created_at": "2026-06-10T00:00:00Z", "created_by": "sanaok" }
      ]
    },
    {
      "slug": "postgres-store", "section": "decisions", "space": "canopy",
      "title": "ADR-001 · Postgres for the store", "current_version": 1,
      "updated_at": "2026-06-02T00:00:00Z", "updated_by": "sanaok",
      "body": "Use a single Postgres instance as the store. Sections, versions, feed entries, and decisions are all rows.",
      "versions": [
        { "version": 1, "body": "Use a single Postgres instance as the store. Sections, versions, feed entries, and decisions are all rows.", "summary": "Initial ADR", "status": "promoted", "confidence": "high", "created_at": "2026-06-02T00:00:00Z", "created_by": "sanaok" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write `fixtures/dev/feed.json`**

```json
{
  "feed": [
    { "id": 1, "author": "meilin", "summary": "Implemented Mermaid + D2 rendering in the Docs reader", "body": "Fenced mermaid and d2 blocks now render to inline SVG on the client, with the source block as a fallback.", "artifacts": { "prs": ["145"], "commits": ["7b1e004"], "issues": [] }, "created_at": "2026-06-25T11:30:00Z", "tags": ["ui", "architecture"] },
    { "id": 2, "author": "AndresL230", "summary": "Switched MCP token comparison to constant-time", "body": "Replaces the early-return string compare flagged in #138. Adds a timing test that fails on the old implementation.", "artifacts": { "prs": ["142"], "commits": ["a3f9c21"], "issues": [138] }, "created_at": "2026-06-25T10:00:00Z", "tags": ["auth"] },
    { "id": 3, "author": "sanaok", "summary": "Drafted ADR: append-only feed as the system of record", "body": null, "artifacts": { "prs": [], "commits": [], "issues": [150] }, "created_at": "2026-06-25T08:00:00Z", "tags": ["architecture", "data"] }
  ]
}
```

- [ ] **Step 3: Write `fixtures/dev/adrs.json`**

```json
{
  "adrs": [
    { "id": 1, "title": "Agent write contract", "context": "Agents post to Canopy at the end of a session over MCP. Without a fixed contract, writes arrived in inconsistent shapes.", "decision": "Agents write through a typed contract; every write lands STAGED and unplaceable writes go to Triage.", "rationale": "Keeping every agent write non-destructive and staged preserves the human review gate.", "status": "draft", "confidence": "high", "created_at": "2026-06-24T00:00:00Z", "created_by": "devraj" },
    { "id": 2, "title": "Single-accent color system", "context": "Early mocks used several accent colors and gray surfaces.", "decision": "One electric-green accent with two tuned values; no gray surfaces.", "rationale": "A single accent keeps live and active state unambiguous.", "status": "ratified", "confidence": "high", "created_at": "2026-06-12T00:00:00Z", "created_by": "devraj" }
  ]
}
```

- [ ] **Step 4: Write `fixtures/dev/triage.json`**

```json
{
  "needs_triage": [
    { "raw": "The MCP server should rate-limit per token. Proposed 60 writes/min burst, 600/hour sustained.", "reason": "No clear section. Mixes a Reference description with an unmade Decision about limits.", "source_author": "jose-a", "resolved": 0, "created_at": "2026-06-25T09:00:00Z" },
    { "raw": "Onboarding: 1) get added to the org, 2) sign in to Canopy, 3) mint an MCP token in Settings.", "reason": "Ambiguous between Context (team process) and Reference (how-to). Needs a human to choose.", "source_author": "meilin", "resolved": 0, "created_at": "2026-06-24T00:00:00Z" }
  ],
  "milestone_proposals": [
    { "title": "Self-host & deploy guide", "target_date": "2026-09-20", "status": "upcoming", "github_ref": null, "change_summary": "Run the whole store on your own infrastructure.", "confidence": "high", "staged_status": "staged", "created_at": "2026-06-25T00:00:00Z", "created_by": "devraj" }
  ]
}
```

- [ ] **Step 5: Write `fixtures/dev/roadmap.json`**

```json
{
  "narrative": "## Canopy roadmap\n\nCanopy is the team's working memory: agents propose context through a reconciling gate and humans confirm the consequential changes. The near-term focus is trustworthy capture (staged writes, replay-safe) and the read-side brain (ranked FTS across docs, decisions, feed, and roadmap).",
  "version": 1,
  "updated_at": "2026-06-26T00:00:00Z",
  "updated_by": "AndresL230",
  "milestones": [
    { "id": 1, "title": "MCP write contract — GA", "description": "Typed, staged-only writes for every agent over MCP.", "phase": "Now", "target_date": "2026-04-30", "status": "done", "github_ref": "1", "created_at": "2026-03-01T00:00:00Z", "created_by": "sanaok", "updated_at": "2026-04-30T00:00:00Z", "progress": { "closed": 6, "total": 6, "source": "recompute", "computed_at": "2026-06-26T00:00:00Z" } },
    { "id": 2, "title": "Token rotation & audit log", "description": "Constant-time comparison, revoke, and a read trail.", "phase": "Weeks 3-4", "target_date": "2026-06-10", "status": "in_progress", "github_ref": "[160,162,175]", "created_at": "2026-05-01T00:00:00Z", "created_by": "AndresL230", "updated_at": null, "progress": { "closed": 2, "total": 3, "source": "recompute", "computed_at": "2026-06-26T00:00:00Z" } },
    { "id": 3, "title": "Semantic search ranking", "description": "Mixed feed/doc results ordered by meaning, not match.", "phase": "Next", "target_date": "2026-07-18", "status": "upcoming", "github_ref": null, "created_at": "2026-06-01T00:00:00Z", "created_by": "meilin", "updated_at": null }
  ]
}
```

- [ ] **Step 6: Write `fixtures/dev/events.json`** (subject `AndresL230` so My Work populates; one unmapped-login PR feeds the identity sample)

```json
{
  "events": [
    {
      "semantic_key": "gh:pr:145:merged", "event_type": "pr_merged", "ref_number": 145, "subject_login": "AndresL230",
      "provenance": "backfill", "occurred_at": "2026-06-25T11:30:00Z", "recorded_at": "2026-06-25T11:31:00Z",
      "raw": { "pr": { "number": 145, "title": "Render Mermaid + D2 in the Docs reader", "body": "## What\n\nFenced mermaid/d2 blocks render to inline SVG client-side.\n\nCloses #133.", "html_url": "https://github.com/SaplingLearn/sapling/pull/145", "merged": true, "merged_at": "2026-06-25T11:30:00Z", "closed_at": "2026-06-25T11:30:00Z", "user": { "login": "AndresL230" }, "milestone": null } },
      "pr_summary": "Renders fenced mermaid and d2 diagram blocks to inline SVG in the Docs reader, with the source block as a fallback."
    },
    {
      "semantic_key": "gh:pr:142:merged", "event_type": "pr_merged", "ref_number": 142, "subject_login": "AndresL230",
      "provenance": "backfill", "occurred_at": "2026-06-25T10:00:00Z", "recorded_at": "2026-06-25T10:01:00Z",
      "raw": { "pr": { "number": 142, "title": "Constant-time MCP token comparison", "body": "Replaces the early-return string compare flagged in #138. Adds a timing test.", "html_url": "https://github.com/SaplingLearn/sapling/pull/142", "merged": true, "merged_at": "2026-06-25T10:00:00Z", "closed_at": "2026-06-25T10:00:00Z", "user": { "login": "AndresL230" }, "milestone": null } },
      "pr_summary": "Switches MCP bearer-token comparison to a constant-time check and adds a timing test that fails on the old implementation."
    },
    {
      "semantic_key": "gh:issue:160:assigned:AndresL230:2026-06-24T14:00:00Z", "event_type": "issue", "ref_number": 160, "subject_login": "AndresL230",
      "provenance": "backfill", "occurred_at": "2026-06-24T14:00:00Z", "recorded_at": "2026-06-24T14:01:00Z",
      "raw": { "action": "assigned", "issue": { "number": 160, "title": "[P1] Add token revoke endpoint", "body": "Revoke a bearer token from Settings; hash-match then soft-delete.", "html_url": "https://github.com/SaplingLearn/sapling/issues/160", "state": "open", "updated_at": "2026-06-24T14:00:00Z", "user": { "login": "sanaok" }, "assignees": [{ "login": "AndresL230" }], "labels": ["auth"], "milestone": { "number": 2, "open_issues": 1, "closed_issues": 2 } } },
      "issue_summary": "Build the Settings action that revokes a bearer token by hash-match then soft-delete."
    },
    {
      "semantic_key": "gh:issue:175:assigned:AndresL230:2026-06-25T09:30:00Z", "event_type": "issue", "ref_number": 175, "subject_login": "AndresL230",
      "provenance": "backfill", "occurred_at": "2026-06-25T09:30:00Z", "recorded_at": "2026-06-25T09:31:00Z",
      "raw": { "action": "assigned", "issue": { "number": 175, "title": "[P2] Roadmap progress cache backstop", "body": "Scheduled recompute of milestone progress in case a webhook delivery is missed.", "html_url": "https://github.com/SaplingLearn/sapling/issues/175", "state": "open", "updated_at": "2026-06-25T09:30:00Z", "user": { "login": "meilin" }, "assignees": [{ "login": "AndresL230" }], "labels": ["infra"], "milestone": { "number": 2, "open_issues": 1, "closed_issues": 2 } } },
      "issue_summary": "Add a scheduled recompute backstop for the milestone progress cache."
    },
    {
      "semantic_key": "gh:pr:151:merged", "event_type": "pr_merged", "ref_number": 151, "subject_login": "octo-drifter",
      "provenance": "backfill", "occurred_at": "2026-06-22T16:00:00Z", "recorded_at": "2026-06-22T16:01:00Z",
      "raw": { "pr": { "number": 151, "title": "Fix typo in onboarding doc", "body": "One-line copy fix.", "html_url": "https://github.com/SaplingLearn/sapling/pull/151", "merged": true, "merged_at": "2026-06-22T16:00:00Z", "closed_at": "2026-06-22T16:00:00Z", "user": { "login": "octo-drifter" }, "milestone": null } },
      "pr_summary": "Fixes a one-line typo in the onboarding doc."
    }
  ]
}
```

- [ ] **Step 7: Write `fixtures/dev/identity.json`** (unmapped login `octo-drifter` from the PR above)

```json
{
  "identity_tasks": [
    { "login": "octo-drifter", "first_seen": "2026-06-22T16:01:00Z", "status": "pending" }
  ]
}
```

- [ ] **Step 8: Write the failing test `test/seed-coverage.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { getMyWork } from "../src/tools/mywork";
import { get_plan } from "../src/tools/plan";
import { query, get_feed, list_proposals, list_needs_triage, list_adrs, list_identity_tasks } from "../src/tools/reads";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import triage from "../fixtures/dev/triage.json";
import roadmap from "../fixtures/dev/roadmap.json";
import events from "../fixtures/dev/events.json";
import identity from "../fixtures/dev/identity.json";

const fx = { docs, feed, adrs, triage, roadmap, events, identity };

beforeEach(async () => {
  for (const stmt of buildSeedStatements(fx)) {
    await env.DB.prepare(stmt).run();
  }
});

describe("dev seed lights up every surface", () => {
  it("My Work: previous activity + to-dos for AndresL230", async () => {
    const mw = await getMyWork(env.DB, "AndresL230");
    expect(mw.degraded).toBe(false);
    expect(mw.person).toBe("Andres");
    expect(mw.previousActivity.length).toBeGreaterThan(0);
    expect(mw.todo.length).toBeGreaterThan(0);
    // Priority tag parsed + stripped from an assigned issue.
    expect(mw.todo.some((t) => t.priority === "P1")).toBe(true);
  });

  it("Roadmap: narrative + milestones carrying progress", async () => {
    const plan = await get_plan(env.DB);
    expect(plan.narrative.length).toBeGreaterThan(0);
    expect(plan.milestones.length).toBe(3);
    expect(plan.milestones.some((m) => m.progress && m.progress.total > 0)).toBe(true);
  });

  it("Search: ranked hits for a known term", async () => {
    const r = await query(env.DB, { q: "MCP", include_staged: true });
    expect(r.primary.length).toBeGreaterThan(0);
  });

  it("Feed: tagged entries present", async () => {
    expect((await get_feed(env.DB, {})).length).toBeGreaterThan(0);
  });

  it("Triage: all four queues populated", async () => {
    expect((await list_proposals(env.DB)).length).toBeGreaterThan(0);
    expect((await list_needs_triage(env.DB)).length).toBeGreaterThan(0);
    expect((await list_adrs(env.DB, "draft")).length).toBeGreaterThan(0);
    expect((await list_identity_tasks(env.DB)).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 9: Run the coverage test — expect FAIL first, then PASS once fixtures are correct**

Run: `npx vitest run test/seed-coverage.test.ts`
Expected: PASS (all 5 tests). A failure here means a fixture shape is wrong (most likely an `events.raw` mismatch or an out-of-vocab tag/section) — fix the fixture, not the read path.

- [ ] **Step 10: Commit**

```bash
git add fixtures/dev/ test/seed-coverage.test.ts
git commit -m "feat(seed): dev fixtures + coverage guard across every surface"
```

---

## Task 3: CLI loader, npm script, and DEV_LOGIN wiring

Wrap the builder in a CLI that resets and seeds LOCAL D1, refusing `--remote`; expose it as `npm run seed`; point `DEV_LOGIN` at the seeded identity. Ends with an end-to-end verification against a running `wrangler dev`.

**Files:**
- Create: `scripts/seed-dev.mjs`
- Modify: `package.json` (scripts)
- Modify: `.dev.vars` (`DEV_LOGIN=AndresL230`)

**Interfaces:**
- Consumes: `buildSeedStatements`, `targetsRemote` (Task 1); the seven fixture files (Task 2).

- [ ] **Step 1: Write `scripts/seed-dev.mjs`**

```js
#!/usr/bin/env node
// Local-only seed loader. Reads fixtures/dev/*.json, builds escaped SQL via the
// shared builder, and applies it to LOCAL D1 through wrangler. Never touches
// remote D1 — it refuses --remote outright.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSeedStatements, targetsRemote } from "./seed/build.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("seed-dev: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}

const dir = fileURLToPath(new URL("../fixtures/dev/", import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const fx = {
  docs: load("docs.json"),
  feed: load("feed.json"),
  adrs: load("adrs.json"),
  triage: load("triage.json"),
  roadmap: load("roadmap.json"),
  events: load("events.json"),
  identity: load("identity.json"),
};

const statements = buildSeedStatements(fx);
const sql = statements.map((s) => s + ";").join("\n");

const file = join(mkdtempSync(join(tmpdir(), "canopy-seed-")), "seed.sql");
writeFileSync(file, sql, "utf8");

console.log(`seed-dev: applying ${statements.length} statements to LOCAL D1…`);
execFileSync("npx", ["wrangler", "d1", "execute", "canopy", "--local", `--file=${file}`], { stdio: "inherit" });
console.log("seed-dev: done — local D1 seeded for every surface. Set DEV_LOGIN=AndresL230 and run `npm run dev`.");
```

- [ ] **Step 2: Add the `seed` script to `package.json`**

In the `"scripts"` block, add (after `"db:migrate:remote"`):

```json
    "seed": "node scripts/seed-dev.mjs"
```

- [ ] **Step 3: Point `.dev.vars` at the seeded identity**

Set the `DEV_LOGIN` line in `.dev.vars` to:

```
DEV_LOGIN=AndresL230
```

- [ ] **Step 4: Verify the loader refuses remote**

Run: `npm run seed -- --remote`
Expected: prints `seed-dev: refusing --remote…` and exits non-zero. Nothing is written.

- [ ] **Step 5: Apply migrations + seed local D1**

Run:
```bash
npm run db:migrate:local
npm run seed
```
Expected: wrangler reports the statements executed against local D1 with no errors; final line `seed-dev: done — local D1 seeded for every surface.`

- [ ] **Step 6: End-to-end verification against the app**

Run `npm run dev`, then in a second shell exercise the seeded surfaces (DEV_LOGIN bypasses auth, so no cookie needed):

```bash
curl -s localhost:8787/me/dashboard | head -c 400        # previousActivity + todo non-empty
curl -s localhost:8787/roadmap | head -c 400             # narrative + 3 milestones, progress present
curl -s "localhost:8787/search?q=MCP" | head -c 400      # ranked hits
curl -s localhost:8787/proposals | head -c 400           # staged mcp-server v3
```
Expected: each returns populated JSON. (`/search` defaults to `include_staged:false` — the staged doc v3 won't appear there, but the promoted docs will.)

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (new tests included; no type errors from the `.mjs`/JSON imports).

- [ ] **Step 8: Commit**

```bash
git add scripts/seed-dev.mjs package.json
git commit -m "feat(seed): npm run seed loader (local-only) + DEV_LOGIN wiring"
```

Note: `.dev.vars` is git-ignored — the `DEV_LOGIN` change is local only and is not committed.

---

## Self-Review

**1. Spec coverage:**
- JSON fixtures under `fixtures/dev/` → Task 2 (all seven files). ✓
- `scripts/seed-dev.mjs` loader, reset-then-load, refuse `--remote` → Task 3 (Steps 1, 4) + reset in Task 1. ✓
- `npm run seed` → Task 3 Step 2. ✓
- Vitest coverage guard → Task 2 (`test/seed-coverage.test.ts`). ✓
- Option A (JSON → D1, app reads D1 unchanged; FTS via triggers) → builder inserts base rows only; Search asserted via `query` with no direct FTS seeding. ✓
- Identity wiring `DEV_LOGIN == people == subject_login` = `AndresL230` → Global Constraints + events fixtures + Task 3 Step 3. ✓
- Coverage matrix (Docs staged version, Feed tags, Roadmap plan+phase+progress, My Work events+summaries, Triage four queues, Search) → fixtures in Task 2 + assertions in coverage test. ✓
- Reset mirrors `test/apply-migrations.ts` → Task 1 `reset.mjs` with a cross-reference comment. ✓
- Safety: no worker imports of seed/fixtures; loader local-only → builder/loader are `scripts/`-only; refusal tested. ✓

**2. Placeholder scan:** No TBD/TODO; every code and fixture step shows complete content; every command has an expected result. ✓

**3. Type/name consistency:** `buildSeedStatements` and `targetsRemote` are defined in Task 1 and consumed with the same names/shapes in Tasks 2–3. Fixture keys (`fx.docs.docs`, `fx.triage.milestone_proposals`, `fx.roadmap.milestones[].progress`, `fx.events.events[].raw`, `fx.identity.identity_tasks`) match the builder's reads exactly. Read-path functions (`getMyWork`, `get_plan`, `query`, `get_feed`, `list_proposals`, `list_needs_triage`, `list_adrs`, `list_identity_tasks`) match their `src/tools/` exports. ✓

## Execution notes

- `npm run dev` is intentionally left unchanged; `npm run seed` is the explicit contract. Chaining seed into dev can be added later if desired.
- If a future migration adds a data table, update `scripts/seed/reset.mjs` in lockstep with `test/apply-migrations.ts` — the coverage test will surface FK/constraint breakage.
