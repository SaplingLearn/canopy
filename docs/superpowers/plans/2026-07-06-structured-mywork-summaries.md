# Structured My Work Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker generates structured summary fields (PR: title/what/why/impact; issue: title/summary/next_step) as validated JSON at capture time, stores them as real columns, widens event capture with milestone title/due-on and PR base branch, and the already-componentized option-2a My Work cards render from those fields instead of mocks/regex parsing.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-06-structured-mywork-summaries-design.md`): the two Workers-AI summarizers emit one strict JSON object each, parsed + shape-validated once in `src/tools/summarize.ts` (never at render); any failure degrades to the existing excerpt fallback. New nullable columns on `pr_summaries`/`issue_summaries` carry the fields; `getMyWork` projects them straight into the shared DTO; the web cards read DTO fields. The `**What changed:**` regex convention (`shared/prSummary.ts`) and the temporary mock layer (`web/src/mock.ts`) are deleted.

**Tech Stack:** Cloudflare Worker (TypeScript), D1/SQLite migrations, Workers AI (`@cf/google/gemma-4-26b-a4b-it`), Vitest + Miniflare (`@cloudflare/vitest-pool-workers`), Vite web SPA (template-string renderers, no framework).

## Global Constraints

- Working directory is the git worktree `/home/andresl/Projects/context/.claude/worktrees/canopy-frontend-wireup`, branch `feat/todo-summaries`. The tree starts with UNCOMMITTED card-redesign + mock-layer changes — task 0 below commits them first. Never `git stash`.
- `npm test` (real Miniflare D1) AND `npm run typecheck` must both pass at every commit; `npm test` does NOT run tsc.
- There is NO Workers AI mock in the test pool — `env.AI` exists but throws on use. Stub at the `Summarizer` level (dependency injection), never call the network in tests. Migrations auto-apply from `migrations/` via `readD1Migrations` (vitest.config.ts) — a new migration file needs no config change.
- The Workers AI model stays `@cf/google/gemma-4-26b-a4b-it`. The shared Sync summary budget stays `SUMMARY_BATCH_LIMIT = 20` / `SUMMARY_CALL_DELAY_MS = 500`, PR loop first.
- The summarizers see ONLY the PR/issue's own title+body. `next_step`/`why`/`impact` are null when the body doesn't support them — never invented. `impact` is a user-facing outcome sentence, NEVER a file list.
- Milestone `done`, gate semantics, and event capture rules (which actions are captured; issue summaries only on `assigned`) are unchanged.
- No new dependencies. No summarizer queue (the Queue seam stays a `// SEAM:` comment).
- Run single test files with `npx vitest run test/<file>.test.ts`.

---

### Task 0: Commit the in-tree frontend work

The option-2a cards and the mock layer are already implemented and verified (404/404 tests, typecheck, build all green) but uncommitted. Commit them as-is so every later task has a clean base.

**Files:**
- Commit (no edits): `shared/dashboard.ts`, `src/tools/mywork.ts`, `web/src/render.ts`, `web/src/canopy.css`, `web/src/mock.ts`, `web/src/main.ts`, `test/render.mywork.test.ts`, `test/mywork.test.ts`, `test/mock.mywork.test.ts`

- [ ] **Step 1: Verify the tree is the expected frontend work and green**

Run: `git status --short` — expect only the files listed above (modified or untracked). Then:

Run: `npm test && npm run typecheck`
Expected: `Test Files  52 passed`, tsc exit 0.

- [ ] **Step 2: Commit**

```bash
git add shared/dashboard.ts src/tools/mywork.ts web/src/render.ts web/src/canopy.css web/src/mock.ts web/src/main.ts test/render.mywork.test.ts test/mywork.test.ts test/mock.mywork.test.ts
git commit -m "feat(web): option-2a My Work cards + temporary design-preview mock layer"
```

---

### Task 1: Migration 0018 + structured row types

**Files:**
- Create: `migrations/0018_structured_summaries.sql`
- Modify: `shared/rows.ts` (PrSummaryRow at ~line 152, IssueSummaryRow at ~line 163)
- Test: `test/structured-summary-schema.test.ts` (create)

**Interfaces:**
- Consumes: existing `pr_summaries` / `issue_summaries` tables (0012 / 0017).
- Produces: nullable columns `pr_summaries.title/what/why/impact`, `issue_summaries.title/next_step`; `PrSummaryRow`/`IssueSummaryRow` with matching nullable fields. Task 2's store functions write these; Task 6's projection reads them.

- [ ] **Step 1: Write the failing schema test**

Create `test/structured-summary-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";

// pr_summaries.semantic_key REFERENCES events(semantic_key) — seed the parent
// row first, mirroring the real call order (same idiom as summarize.test.ts).
async function seedEvent(semanticKey: string, prNumber: number): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, 'pr_merged', ?, 'someone', '{}', 'webhook', NULL, ?, 'github-webhook')`,
    semanticKey,
    prNumber,
    nowIso()
  );
}

describe("0018_structured_summaries schema", () => {
  it("pr_summaries accepts and returns the four structured columns", async () => {
    await seedEvent("gh:pr:900:merged", 900);
    await run(
      env.DB,
      `INSERT INTO pr_summaries (semantic_key, pr_number, summary, model, created_at, title, what, why, impact)
       VALUES ('gh:pr:900:merged', 900, 'prose', 'm', ?, 'T', 'W', 'Y', 'I')`,
      nowIso()
    );
    const rows = await all<{ title: string | null; what: string | null; why: string | null; impact: string | null }>(
      env.DB,
      `SELECT title, what, why, impact FROM pr_summaries WHERE semantic_key = 'gh:pr:900:merged'`
    );
    expect(rows[0]).toEqual({ title: "T", what: "W", why: "Y", impact: "I" });
  });

  it("issue_summaries accepts and returns title/next_step, and both default NULL", async () => {
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at, title, next_step)
       VALUES (901, 'prose', 'm', ?, 'T', 'N')`,
      nowIso()
    );
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at) VALUES (902, 'prose', 'excerpt', ?)`,
      nowIso()
    );
    const rows = await all<{ issue_number: number; title: string | null; next_step: string | null }>(
      env.DB,
      `SELECT issue_number, title, next_step FROM issue_summaries ORDER BY issue_number`
    );
    expect(rows).toEqual([
      { issue_number: 901, title: "T", next_step: "N" },
      { issue_number: 902, title: null, next_step: null },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/structured-summary-schema.test.ts`
Expected: FAIL — `table pr_summaries has no column named title`.

- [ ] **Step 3: Write the migration**

Create `migrations/0018_structured_summaries.sql`:

```sql
-- Structured summary fields (spec 2026-07-06-structured-mywork-summaries).
-- All NULLable: NULL means a prose-era or excerpt-fallback row. `title IS NOT
-- NULL` doubles as the structured-generation marker the Sync skip-check reads
-- (a row is "done" only when model != 'excerpt' AND title IS NOT NULL).
-- `summary` stays NOT NULL as the prose mirror: `what` (PRs) / the structured
-- summary field (issues) on success, the deterministic excerpt on fallback.
ALTER TABLE pr_summaries ADD COLUMN title TEXT;
ALTER TABLE pr_summaries ADD COLUMN what TEXT;
ALTER TABLE pr_summaries ADD COLUMN why TEXT;
ALTER TABLE pr_summaries ADD COLUMN impact TEXT;
ALTER TABLE issue_summaries ADD COLUMN title TEXT;
ALTER TABLE issue_summaries ADD COLUMN next_step TEXT;
```

- [ ] **Step 4: Extend the row types**

In `shared/rows.ts`, replace the two summary row interfaces:

```ts
// Worker-generated completed-PR summary (0012; structured fields 0018).
// Derived, regenerable, never truth. Structured fields are NULL on prose-era
// and excerpt-fallback rows; `summary` mirrors `what` on structured success.
export interface PrSummaryRow {
  semantic_key: string;
  pr_number: number;
  summary: string;
  model: string | null;    // 'excerpt' = deterministic fallback
  created_at: string;
  title: string | null;    // humanized display title (0018)
  what: string | null;     // "What changed" (0018)
  why: string | null;      // motivation, only when the body states one (0018)
  impact: string | null;   // user-facing outcome sentence, never files (0018)
}

// Worker-generated summary of ONE assigned issue's own body (0017; structured
// fields 0018). Derived, regenerable, never truth — keyed by issue number (not
// semantic_key), since only the current summary matters across reassignments/
// edits. Structured fields NULL on prose-era and excerpt-fallback rows.
export interface IssueSummaryRow {
  issue_number: number;
  summary: string;
  model: string | null;      // 'excerpt' = deterministic fallback
  created_at: string;
  title: string | null;      // humanized display title (0018)
  next_step: string | null;  // only when the issue states/implies one (0018)
}
```

- [ ] **Step 5: Run the test to verify it passes, then the full suite**

Run: `npx vitest run test/structured-summary-schema.test.ts` — Expected: PASS (2 tests).

Then make `src/tools/summarize.ts` compile against the widened row types: its two `return { … }` literals (in `storePrSummary` and `storeIssueSummary`) are now missing required properties. Add `title: null, what: null, why: null, impact: null,` to the PR literal and `title: null, next_step: null,` to the issue literal as a stopgap — Task 2 rewrites both functions properly.

Run: `npm test && npm run typecheck` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add migrations/0018_structured_summaries.sql shared/rows.ts test/structured-summary-schema.test.ts src/tools/summarize.ts
git commit -m "feat(db): 0018 structured summary columns on pr_summaries/issue_summaries"
```

---

### Task 2: Structured summarizers — JSON prompts, parse/validate, store functions

**Files:**
- Modify: `src/tools/summarize.ts` (full rewrite of prompts, interface, factory, store fns)
- Modify: `src/webhook.ts:5,246,261,286` (generic type ripple only)
- Modify: `src/tools/backfill.ts:6,145-146` (generic type ripple only)
- Test: `test/summarize.test.ts` (update stubs + prompt tests, add parse/validate tests), `test/webhook.test.ts:16,43,198,207,229` (stub shape), `test/backfill.test.ts:6,25` + all `countingSummarizer(...)` call sites (stub shape)

**Interfaces:**
- Consumes: Task 1's columns and row types.
- Produces (used by Tasks 3–7):
  - `export interface PrSummary { title: string; what: string; why: string | null; impact: string | null }`
  - `export interface IssueSummary { title: string; summary: string; next_step: string | null }`
  - `export interface Summarizer<T> { readonly model: string; summarize(input: { title: string; body: string }): Promise<T | null> }`
  - `export function workersAiPrSummarizer(ai: Ai): Summarizer<PrSummary>`
  - `export function workersAiIssueSummarizer(ai: Ai): Summarizer<IssueSummary>`
  - `export function parseStructuredJson(text: string): Record<string, unknown> | null`
  - `export function validatePrSummary(o: Record<string, unknown>): PrSummary | null`
  - `export function validateIssueSummary(o: Record<string, unknown>): IssueSummary | null`
  - `storePrSummary(db, summarizer: Summarizer<PrSummary> | null, pr): Promise<PrSummaryRow>` / `storeIssueSummary(db, summarizer: Summarizer<IssueSummary> | null, issue): Promise<IssueSummaryRow>` — signatures otherwise unchanged; on structured success `summary` = `what` (PR) / structured `summary` (issue), on any failure exactly today's excerpt fallback with NULL structured columns.

- [ ] **Step 1: Write the failing tests**

In `test/summarize.test.ts`:

(a) Replace the import block's summarize imports with:

```ts
import {
  type PrSummary,
  type IssueSummary,
  storePrSummary,
  storeIssueSummary,
  excerptSummary,
  parseStructuredJson,
  validatePrSummary,
  validateIssueSummary,
  SUMMARIZER_SYSTEM_PROMPT,
  ISSUE_SUMMARIZER_SYSTEM_PROMPT,
  workersAiPrSummarizer,
  workersAiIssueSummarizer,
} from "../src/tools/summarize";
import type { Summarizer } from "../src/tools/summarize";
```

(b) Add new describe blocks:

```ts
describe("parseStructuredJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseStructuredJson('{"a": 1}')).toEqual({ a: 1 });
  });
  it("strips a ```json fence", () => {
    expect(parseStructuredJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("returns null for prose, malformed JSON, arrays, and null", () => {
    expect(parseStructuredJson("Just prose.")).toBeNull();
    expect(parseStructuredJson('{"a": ')).toBeNull();
    expect(parseStructuredJson("[1,2]")).toBeNull();
    expect(parseStructuredJson("null")).toBeNull();
  });
});

describe("validatePrSummary", () => {
  it("accepts a full object, trimming every field", () => {
    expect(validatePrSummary({ title: " T ", what: " W ", why: " Y ", impact: " I " }))
      .toEqual({ title: "T", what: "W", why: "Y", impact: "I" });
  });
  it("coerces empty/absent nullable fields to null", () => {
    expect(validatePrSummary({ title: "T", what: "W", why: "", impact: undefined }))
      .toEqual({ title: "T", what: "W", why: null, impact: null });
  });
  it("rejects a missing or empty required field", () => {
    expect(validatePrSummary({ what: "W" })).toBeNull();
    expect(validatePrSummary({ title: "  ", what: "W" })).toBeNull();
    expect(validatePrSummary({ title: "T", what: "" })).toBeNull();
  });
  it("rejects non-string junk in any field", () => {
    expect(validatePrSummary({ title: "T", what: "W", why: 7, impact: null })).toBeNull();
    expect(validatePrSummary({ title: 3, what: "W" })).toBeNull();
  });
});

describe("validateIssueSummary", () => {
  it("accepts a full object and coerces empty next_step to null", () => {
    expect(validateIssueSummary({ title: "T", summary: "S", next_step: "" }))
      .toEqual({ title: "T", summary: "S", next_step: null });
  });
  it("rejects a missing required field or junk next_step", () => {
    expect(validateIssueSummary({ title: "T" })).toBeNull();
    expect(validateIssueSummary({ title: "T", summary: "S", next_step: 4 })).toBeNull();
  });
});
```

(c) Replace the two prompt describe blocks (currently asserting plain prose) with:

```ts
describe("SUMMARIZER_SYSTEM_PROMPT", () => {
  it("demands a single JSON object with title/what/why/impact and forbids file lists and extrapolation", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/single json object/i);
    for (const field of ['"title"', '"what"', '"why"', '"impact"']) {
      expect(SUMMARIZER_SYSTEM_PROMPT).toContain(field);
    }
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/never a list of files/i);
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/never extrapolate/i);
  });
});

describe("ISSUE_SUMMARIZER_SYSTEM_PROMPT", () => {
  it("demands a single JSON object with title/summary/next_step and forbids invented next steps", () => {
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toMatch(/single json object/i);
    for (const field of ['"title"', '"summary"', '"next_step"']) {
      expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain(field);
    }
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toMatch(/never invent/i);
  });
});
```

(d) Update the `storePrSummary`/`storeIssueSummary` describes: replace every string-returning stub. The canonical stubs:

```ts
const PR_STUB: PrSummary = { title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." };
const ISSUE_STUB: IssueSummary = { title: "Humanized issue title", summary: "What the issue is.", next_step: "Do the thing." };
```

The first `storePrSummary` test becomes (after its existing `seedEvent` call):

```ts
    const stub: Summarizer<PrSummary> = { model: "stub-model", summarize: async () => PR_STUB };
    const row = await storePrSummary(env.DB, stub, { semantic_key: "gh:pr:1:merged", pr_number: 1, title: "t", body: "b" });
    expect(row.model).toBe("stub-model");
    expect(row.summary).toBe("The concrete change."); // prose mirror of `what`
    expect(row).toMatchObject({ title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." });
    const stored = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = 'gh:pr:1:merged'`);
    expect(stored[0]).toMatchObject({ summary: "The concrete change.", title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." });
```

The fallback tests (`summarize: async () => null`, throwing stub, `null` summarizer) keep their existing assertions and ADD:

```ts
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
```

Mirror the same pattern for `storeIssueSummary` (structured success stores `title`/`next_step`, `summary` = the stub's `summary` field; fallbacks store NULLs). Update the "webhook → summarize wiring" describe's stubs the same way (its stored-row assertions on `summary` text must expect the stub's `what` value).

(e) Update the "response shape handling" describe: the fake `ai.run` results must now return JSON strings, e.g.

```ts
const PR_JSON = '{"title": "T", "what": "W", "why": null, "impact": null}';
```

flat shape → `{ response: PR_JSON }` expecting `toEqual({ title: "T", what: "W", why: null, impact: null })`; chat shape → same JSON in `choices[0].message.content`; and ADD one case: a prose (non-JSON) response resolves to `null`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/summarize.test.ts`
Expected: FAIL — `parseStructuredJson` is not exported, etc.

- [ ] **Step 3: Rewrite `src/tools/summarize.ts`**

Replace the interface, prompts, and factory (keep `extractResponseText`, `excerptSummary`, `EXCERPT_MAX`, the file-top comment, and the imports; drop nothing else silently):

```ts
/** Structured PR summary — the JSON object the PR prompt demands. */
export interface PrSummary {
  title: string;          // humanized display title, grounded in the real title+body
  what: string;           // the concrete change that shipped
  why: string | null;     // motivation, only when the body states one
  impact: string | null;  // one user-facing outcome sentence, never files
}

/** Structured issue summary — the JSON object the issue prompt demands. */
export interface IssueSummary {
  title: string;
  summary: string;          // plain restatement of what the issue is
  next_step: string | null; // only when the issue states/implies an action
}

/** One PR/issue's title+body in, a validated structured summary (or null) out.
 *  `model` is the provenance recorded on the stored row. */
export interface Summarizer<T> {
  readonly model: string;
  summarize(input: { title: string; body: string }): Promise<T | null>;
}

export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this pull request for a team activity feed — what shipped. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "what": string, "why": string or null, "impact": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the PR did, grounded only in the provided title and description — never invent scope. ' +
  '"what": 1-2 sentences leading with the concrete change that shipped; do not just restate the title. ' +
  '"why": the motivation, only where the description states one; else null. ' +
  '"impact": one sentence on the outcome for people using the product — what it enables or fixes; NEVER a list of files touched; null when the description does not support one. ' +
  "The description records work that already happened — report what it states, never extrapolate beyond it. " +
  'If the description is empty or too thin to add anything beyond the title, use the title verbatim for "title" and "what" and null for "why" and "impact".';

export const ISSUE_SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this GitHub issue for a personal to-do list. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "summary": string, "next_step": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the issue is about, grounded only in its title and description. ' +
  '"summary": 1-3 sentences plainly restating what the issue is, grounded only in its title and description. ' +
  '"next_step": what needs doing, ONLY where the issue states or clearly implies an action; if the issue is vague, aspirational, or states no clear action, use null — never invent a next step, a plan, or a scope the issue never stated. ' +
  'If the description is empty or too thin, use the title verbatim for "title" and "summary" and null for "next_step".';

/** Extracts the single JSON object a summarizer prompt demands. Strips an
 *  accidental markdown fence; anything that isn't one JSON object → null. */
export function parseStructuredJson(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Field coercion: required = non-empty string after trim (else the whole
// object is rejected); nullable = trimmed string, '' / null / undefined → null,
// any other type rejects the whole object (undefined is the reject marker).
function reqStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function nullableStr(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function validatePrSummary(o: Record<string, unknown>): PrSummary | null {
  const title = reqStr(o.title);
  const what = reqStr(o.what);
  if (title === null || what === null) return null;
  const why = nullableStr(o.why);
  const impact = nullableStr(o.impact);
  if (why === undefined || impact === undefined) return null;
  return { title, what, why, impact };
}

export function validateIssueSummary(o: Record<string, unknown>): IssueSummary | null {
  const title = reqStr(o.title);
  const summary = reqStr(o.summary);
  if (title === null || summary === null) return null;
  const next_step = nullableStr(o.next_step);
  if (next_step === undefined) return null;
  return { title, summary, next_step };
}

/** Shared Workers AI call machinery for both summarizers — only the prompt and
 *  validator differ. Never throws: any failure (network, empty output, prose
 *  instead of JSON, malformed/mistyped fields) resolves to null so the caller
 *  falls back to excerptSummary. */
function makeWorkersAiSummarizer<T>(
  ai: Ai,
  systemPrompt: string,
  validate: (o: Record<string, unknown>) => T | null
): Summarizer<T> {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      try {
        const result = await ai.run(WORKERS_AI_MODEL, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
          ],
        });
        const response = extractResponseText(result);
        if (response === null) return null;
        const obj = parseStructuredJson(response);
        if (obj === null) return null;
        return validate(obj);
      } catch (err) {
        // TEMPORARY diagnostic logging — remove once the production failure
        // mode under sustained backfill load is identified (see tail output).
        const kind = systemPrompt === SUMMARIZER_SYSTEM_PROMPT ? "pr" : "issue";
        console.error(`workersAiSummarizer (${kind}) failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent. */
export function workersAiPrSummarizer(ai: Ai): Summarizer<PrSummary> {
  return makeWorkersAiSummarizer(ai, SUMMARIZER_SYSTEM_PROMPT, validatePrSummary);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent. */
export function workersAiIssueSummarizer(ai: Ai): Summarizer<IssueSummary> {
  return makeWorkersAiSummarizer(ai, ISSUE_SUMMARIZER_SYSTEM_PROMPT, validateIssueSummary);
}
```

Replace both store functions:

```ts
/**
 * Try the summarizer, fall back to excerptSummary (model:'excerpt', NULL
 * structured columns) on any null/throw. On structured success `summary`
 * mirrors `what` — sane prose for any reader of the old column. INSERT OR
 * REPLACE keeps one row per semantic_key. NEVER throws — a summary failure
 * must not fail the webhook capture that triggered it.
 */
export async function storePrSummary(
  db: DB,
  summarizer: Summarizer<PrSummary> | null,
  pr: { semantic_key: string; pr_number: number; title: string; body: string }
): Promise<PrSummaryRow> {
  let structured: PrSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: pr.title, body: pr.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const summary = structured ? structured.what : excerptSummary(pr.title, pr.body);
  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO pr_summaries (semantic_key, pr_number, summary, model, created_at, title, what, why, impact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pr.semantic_key,
    pr.pr_number,
    summary,
    model,
    created_at,
    structured?.title ?? null,
    structured?.what ?? null,
    structured?.why ?? null,
    structured?.impact ?? null
  );
  return {
    semantic_key: pr.semantic_key,
    pr_number: pr.pr_number,
    summary,
    model,
    created_at,
    title: structured?.title ?? null,
    what: structured?.what ?? null,
    why: structured?.why ?? null,
    impact: structured?.impact ?? null,
  };
}

/**
 * Issue mirror of storePrSummary: `summary` is the structured summary field on
 * success, the excerpt on fallback; title/next_step NULL on fallback. INSERT OR
 * REPLACE keeps one row per issue_number. NEVER throws.
 */
export async function storeIssueSummary(
  db: DB,
  summarizer: Summarizer<IssueSummary> | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow> {
  let structured: IssueSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: issue.title, body: issue.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const summary = structured ? structured.summary : excerptSummary(issue.title, issue.body);
  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at, title, next_step)
     VALUES (?, ?, ?, ?, ?, ?)`,
    issue.issue_number,
    summary,
    model,
    created_at,
    structured?.title ?? null,
    structured?.next_step ?? null
  );
  return {
    issue_number: issue.issue_number,
    summary,
    model,
    created_at,
    title: structured?.title ?? null,
    next_step: structured?.next_step ?? null,
  };
}
```

- [ ] **Step 4: Ripple the generic through the two callers (types only)**

`src/webhook.ts`: line 5's import gains the types — `import { type Summarizer, type PrSummary, type IssueSummary, workersAiPrSummarizer, workersAiIssueSummarizer, storePrSummary, storeIssueSummary } from "./tools/summarize";` — then `summarizePrSeam(db: DB, summarizer: Summarizer<PrSummary> | null, …)`, `summarizeIssueSeam(db: DB, summarizer: Summarizer<IssueSummary> | null, …)`, and `opts?: { summarizer?: Summarizer<PrSummary> | null; issueSummarizer?: Summarizer<IssueSummary> | null }`. No logic changes.

`src/tools/backfill.ts`: line 6's import gains `type PrSummary, type IssueSummary`; opts becomes `summarizer?: Summarizer<PrSummary> | null; issueSummarizer?: Summarizer<IssueSummary> | null`. No logic changes.

- [ ] **Step 5: Update the remaining test stubs**

`test/webhook.test.ts`: import becomes `import type { Summarizer, PrSummary, IssueSummary } from "../src/tools/summarize";`; the `postWebhook` opts type mirrors webhook.ts's; the three inline stubs become object-returning, e.g. line 198: `const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "What it is and what to do.", next_step: null }) };` (any assertion on the stored `summary` text expects the stub's `summary` field). Line 207's never-called stub: same shape, any values. Line 229: same.

`test/backfill.test.ts`: import gains `type PrSummary, type IssueSummary`; replace `countingSummarizer`:

```ts
function countingSummarizer<T>(result: T): Summarizer<T> & { calls: number } {
  const s: Summarizer<T> & { calls: number } = {
    calls: 0,
    model: "test-model",
    async summarize() {
      s.calls++;
      return result;
    },
  };
  return s;
}
const PR_STUB: PrSummary = { title: "Humanized PR", what: "AI summary", why: null, impact: null };
const ISSUE_STUB: IssueSummary = { title: "Humanized issue", summary: "Issue AI summary", next_step: null };
```

Call-site mapping (assertions on stored `summary` text keep passing because `summary` mirrors `what` / the issue `summary` field):
- `countingSummarizer("AI summary")` → `countingSummarizer(PR_STUB)`
- `countingSummarizer("Issue AI summary")` → `countingSummarizer(ISSUE_STUB)`
- `countingSummarizer("**What changed:** AI summary")` → `countingSummarizer(PR_STUB)`
- `countingSummarizer("A real AI summary.")` → `countingSummarizer({ ...PR_STUB, what: "A real AI summary." })`
- `countingSummarizer("Plain prose, no headings — the new richer style.")` → `countingSummarizer({ ...PR_STUB, what: "Plain prose, no headings — the new richer style." })`
- any other string call site → `countingSummarizer({ ...PR_STUB, what: "<that string>" })` (PR path) or `countingSummarizer({ ...ISSUE_STUB, summary: "<that string>" })` (issue path)
- `const nullSummarizer: Summarizer = { model: "stub", summarize: async () => null }` → `const nullSummarizer: Summarizer<PrSummary> = { model: "stub", summarize: async () => null }`

If any assertion checked the literal `**What changed:**` text in a stored summary, update it to the stub's `what` value.

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/summarize.test.ts test/webhook.test.ts test/backfill.test.ts` — Expected: PASS.
Run: `npm test && npm run typecheck` — Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/summarize.ts src/webhook.ts src/tools/backfill.ts test/summarize.test.ts test/webhook.test.ts test/backfill.test.ts
git commit -m "feat(summarize): structured JSON summarizers (PR title/what/why/impact, issue title/summary/next_step) validated at capture"
```

---

### Task 3: Capture widening — milestone title/due_on and PR base.ref

**Files:**
- Modify: `src/webhook.ts` (`GhMilestone` ~line 56, `GhPullRequest` ~line 64, PR raw ~line 124, issue raw ~line 190)
- Modify: `src/tools/backfill.ts` (`GhMilestoneLite` ~line 56, `GhPrListItem` ~line 61, `prClosedDelivery` ~line 97, `issueDelivery` ~line 117)
- Modify: `test/fixtures/gh-pr-merged.json`, `test/fixtures/gh-issue-assigned.json` (and `test/fixtures/gh-issue-closed.json` if it carries a milestone — add the same fields)
- Test: `test/webhook.test.ts` (two new capture assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces (read by Task 6's projection): `raw.pr.base: { ref: string } | null` on PR events; `raw.issue.milestone.title: string | null` and `raw.issue.milestone.due_on: string | null` on issue events. Backfill deliveries carry identical shapes (both come straight from GitHub payloads — no new API calls).

- [ ] **Step 1: Write the failing tests**

In `test/webhook.test.ts`, add to the existing capture describe (reusing `postWebhook` and the fixture imports):

```ts
  it("captures the PR base branch in raw (footer 'into <base>' source)", async () => {
    await postWebhook("pull_request", prMerged, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE semantic_key = 'gh:pr:42:merged'`);
    const raw = JSON.parse(rows[0].raw) as { pr: { base: { ref: string } | null } };
    expect(raw.pr.base).toEqual({ ref: "main" });
  });

  it("captures the issue milestone title and due date in raw (Milestone row source)", async () => {
    await postWebhook("issues", issueAssigned, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE event_type = 'issue'`);
    const raw = JSON.parse(rows[0].raw) as { issue: { milestone: { number: number; title: string | null; due_on: string | null } } };
    expect(raw.issue.milestone).toMatchObject({ number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/webhook.test.ts`
Expected: FAIL — `raw.pr.base` is `undefined`; milestone has no `title`.

- [ ] **Step 3: Widen the fixtures**

`test/fixtures/gh-pr-merged.json` — inside `"pull_request"`, after the `"user"` line, add:

```json
    "base": { "ref": "main" },
```

`test/fixtures/gh-issue-assigned.json` — replace the milestone line with:

```json
    "milestone": { "number": 3, "title": "Reliable event capture", "due_on": "2026-07-20T07:00:00Z", "open_issues": 2, "closed_issues": 4 }
```

(If `gh-issue-closed.json` has a `"milestone"`, widen it identically.)

- [ ] **Step 4: Widen the webhook capture**

In `src/webhook.ts`:

```ts
interface GhMilestone {
  number: number;
  title?: string | null;
  due_on?: string | null;
  open_issues?: number;
  closed_issues?: number;
}
```

`GhPullRequest` gains `base?: { ref: string } | null;` (after `milestone`).

PR raw builder — after the `milestone:` line inside the `pr: { … }` literal:

```ts
        base: pr.base ? { ref: pr.base.ref } : null,
```

Issue raw builder — the milestone literal becomes:

```ts
        milestone: issue.milestone
          ? {
              number: issue.milestone.number,
              title: issue.milestone.title ?? null,
              due_on: issue.milestone.due_on ?? null,
              open_issues: issue.milestone.open_issues,
              closed_issues: issue.milestone.closed_issues,
            }
          : null,
```

- [ ] **Step 5: Mirror in the backfill delivery synthesizers**

In `src/tools/backfill.ts`: `GhMilestoneLite` gains `title?: string | null; due_on?: string | null;`; `GhPrListItem` gains `base?: { ref: string } | null;`. In `prClosedDelivery`, after the `user:` line add `base: pr.base ? { ref: pr.base.ref } : null,` and in `issueDelivery` the milestone literal becomes:

```ts
      milestone: issue.milestone
        ? {
            number: issue.milestone.number,
            title: issue.milestone.title ?? null,
            due_on: issue.milestone.due_on ?? null,
            open_issues: issue.milestone.open_issues,
            closed_issues: issue.milestone.closed_issues,
          }
        : null,
```

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/webhook.test.ts test/backfill.test.ts test/summarize.test.ts` — Expected: PASS (fixture-driven semantic keys are unchanged; if a backfill test asserts an exact `raw` object, extend that assertion with the new fields rather than weakening it).
Run: `npm test && npm run typecheck` — Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/webhook.ts src/tools/backfill.ts test/fixtures test/webhook.test.ts test/backfill.test.ts
git commit -m "feat(capture): widen event raw with issue milestone title/due_on and PR base.ref"
```

---

### Task 4: Sync skip-check — regenerate prose-era summaries once

**Files:**
- Modify: `src/tools/backfill.ts` (~lines 29-31 comment, 241-247 PR skip, 299-305 issue skip)
- Test: `test/backfill.test.ts` (one new test; existing skip tests keep passing)

**Interfaces:**
- Consumes: Task 1's `title` columns; Task 2's structured store fns.
- Produces: "already summarized" ≡ `model !== 'excerpt' AND title IS NOT NULL` — prose-era AI rows (model set, title NULL) regenerate exactly once; structured rows skip; excerpt rows keep retrying. Counter names unchanged.

- [ ] **Step 1: Write the failing test**

In `test/backfill.test.ts`, add (reusing that file's existing `envWith()` / `fetchImpl` helpers and stubs — mirror the neighboring skip-check test's setup exactly):

```ts
  it("re-summarizes a prose-era row (model set, title NULL) exactly once, then skips it", async () => {
    const fetchImpl = ghFetchStub(); // whatever helper the neighboring tests use for the two list responses
    const summarizer = countingSummarizer(PR_STUB);
    const issueSummarizer = countingSummarizer(ISSUE_STUB);

    // First run captures the PR and writes a structured summary.
    const first = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0 });
    expect(first.ok).toBe(true);
    expect(summarizer.calls).toBeGreaterThan(0);

    // Simulate a prose-era row: model kept, structured columns wiped.
    await run(env.DB, `UPDATE pr_summaries SET title = NULL, what = NULL, why = NULL, impact = NULL`);

    const second = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0 });
    const callsAfterSecond = summarizer.calls;
    expect(second.ok).toBe(true);

    // Third run: the row is structured again — skipped, no further calls.
    const third = await runBackfill(envWith(), "admin-user", { fetchImpl, summarizer, issueSummarizer, summaryCallDelayMs: 0 });
    expect(third.ok).toBe(true);
    expect(summarizer.calls).toBe(callsAfterSecond);
  });
```

(Adapt the two helper names to the file's actual ones when writing the test — the file already stubs GitHub's two list fetches for every runBackfill test; import `run` from `../src/db` if not already imported.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/backfill.test.ts`
Expected: the new test FAILS — after wiping `title`, the second run does NOT re-summarize (old check sees `model !== 'excerpt'` and skips), so `summarizer.calls` never increases.

- [ ] **Step 3: Redefine both skip checks**

In `src/tools/backfill.ts`, PR loop:

```ts
      const existing = await first<PrSummaryRow>(
        env.DB,
        `SELECT model, title FROM pr_summaries WHERE semantic_key = ?`,
        ev.semantic_key
      );
      // "Done" = a real (non-excerpt) summary that is ALSO structured — title
      // doubles as the structured-generation marker (0018), so prose-era rows
      // regenerate exactly once under the shared budget.
      const alreadySummarized = existing !== null && existing.model !== "excerpt" && existing.title !== null;
```

Issue loop, identically:

```ts
      const existing = await first<IssueSummaryRow>(
        env.DB,
        `SELECT model, title FROM issue_summaries WHERE issue_number = ?`,
        issue.number
      );
      const alreadySummarized = existing !== null && existing.model !== "excerpt" && existing.title !== null;
```

Update the file-top comment's `the model≠excerpt skip-check` to `the model≠excerpt-and-structured skip-check`. The two "only count it toward done" post-store checks become `if (stored.model !== "excerpt" && stored.title !== null)` for symmetry.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/backfill.test.ts` — Expected: PASS (including the pre-existing excerpt-retry test — excerpt rows have NULL title too, so they still retry).
Run: `npm test && npm run typecheck` — Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/backfill.ts test/backfill.test.ts
git commit -m "feat(backfill): treat only structured non-excerpt summaries as done — prose-era rows regenerate once"
```

---

### Task 5: Delete the mock preview layer

**Files:**
- Delete: `web/src/mock.ts`, `test/mock.mywork.test.ts`
- Modify: `web/src/main.ts` (~lines 17-19 import, ~99-101 call site)

**Interfaces:**
- Consumes: nothing.
- Produces: `loadMyWork` stores the raw `/me/dashboard` response — Task 6's real projection is what the page shows from here on.

- [ ] **Step 1: Remove the layer**

```bash
rm web/src/mock.ts test/mock.mywork.test.ts
```

In `web/src/main.ts`, delete the import block (the two comment lines and `import { MYWORK_MOCKS_ENABLED, applyMyWorkMocks } from "./mock";`) and replace the decorated assignment (with its TEMPORARY comment) with:

```ts
      state.mywork = { status: "ok", data };
```

- [ ] **Step 2: Verify no dangling references, run everything**

Run: `grep -rn "mock" web/src/ --include="*.ts"` — Expected: no `./mock` import remains (the unrelated "Phase-1 mock"/Maintenance comments in main.ts may remain).
Run: `npm test && npm run typecheck && npm run build:web` — Expected: all green (51 test files — the mock test file is gone).

- [ ] **Step 3: Commit**

```bash
git add -A web/src/mock.ts web/src/main.ts test/mock.mywork.test.ts
git commit -m "chore(web): delete the temporary My Work design-preview mock layer"
```

---

### Task 6: DTO `what`/`why` + real `getMyWork` projection

**Files:**
- Modify: `shared/dashboard.ts` (`MyWorkPr`)
- Modify: `src/tools/mywork.ts` (join rows, raw types, both queries, both mappings)
- Test: `test/mywork.test.ts` (new projection tests + helper widening), `test/render.mywork.test.ts` (fixture factory gains the two fields — compile only)

**Interfaces:**
- Consumes: Task 1 columns, Task 2 store fns (tests write rows through them), Task 3 raw shapes.
- Produces (read by Task 7's render): `MyWorkPr.what: string | null`, `MyWorkPr.why: string | null`; `displayTitle`/`impact`/`baseRef`/`milestone`/`nextStep` now carry real values. `getMyWork` signature unchanged; degraded posture unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/mywork.test.ts`:

(a) Widen the helpers — `prEvent` gains an optional `baseRef`, `issueEvent` an optional `milestone`:

```ts
function prEvent(over: Partial<CapturedEvent> & { number: number; login: string; merged?: boolean; baseRef?: string | null }): CapturedEvent {
  const { number, login, merged = true, baseRef = null, ...rest } = over;
  const raw = JSON.stringify({
    pr: {
      number,
      title: `PR ${number}`,
      body: "some body",
      html_url: `https://github.com/o/r/pull/${number}`,
      merged,
      merged_at: merged ? NOW : null,
      closed_at: NOW,
      user: { login },
      milestone: null,
      base: baseRef ? { ref: baseRef } : null,
    },
  });
  // …rest of the function unchanged
```

`issueEvent`'s options gain `milestone?: { title?: string | null; due_on?: string | null; number?: number } | null` (default `null`), and its raw's `milestone: null` line becomes `milestone: milestone ?? null,`.

(b) Add a new describe:

```ts
describe("getMyWork — structured fields", () => {
  it("projects the structured PR summary columns and base.ref into the DTO", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(env.DB, prEvent({ number: 7, login: "dev", baseRef: "main" }), "github-webhook");
    const stub: Summarizer<PrSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized seven", what: "Did the thing.", why: "It was broken.", impact: "Users can log in." }),
    };
    await storePrSummary(env.DB, stub, { semantic_key: "gh:pr:7:merged", pr_number: 7, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({
      number: 7,
      displayTitle: "Humanized seven",
      what: "Did the thing.",
      why: "It was broken.",
      impact: "Users can log in.",
      summary: "Did the thing.",
      baseRef: "main",
    });
  });

  it("projects the structured issue summary columns and the milestone into the todo", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(
      env.DB,
      issueEvent({ number: 9, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" } }),
      "github-webhook"
    );
    const stub: Summarizer<IssueSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized nine", summary: "What it is.", next_step: "Do the fix." }),
    };
    await storeIssueSummary(env.DB, stub, { issue_number: 9, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.todo[0]).toMatchObject({
      number: 9,
      displayTitle: "Humanized nine",
      summary: "What it is.",
      nextStep: "Do the fix.",
      milestone: { title: "Reliable event capture", dueOn: "2026-07-20T07:00:00Z" },
    });
  });

  it("yields nulls for a legacy raw (no base, milestone without title) and a prose-era summary row", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(env.DB, prEvent({ number: 8, login: "dev" }), "github-webhook");
    await ingestEvent(
      env.DB,
      issueEvent({ number: 10, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3 } }),
      "github-webhook"
    );
    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({ number: 8, displayTitle: null, what: null, why: null, impact: null, baseRef: null });
    expect(work.todo[0]).toMatchObject({ number: 10, displayTitle: null, nextStep: null, milestone: null });
  });
});
```

Add the needed imports: `run` from `../src/db`, `type Summarizer, type PrSummary, type IssueSummary` from `../src/tools/summarize` (extend the existing import lines). Any pre-existing `toMatchObject` assertions that pin `displayTitle: null` etc. on summarized items must be revisited: with string stubs gone (Task 2), summarized rows now HAVE structured values — update those expectations to the stub's fields.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mywork.test.ts`
Expected: the new describe FAILS (`what` missing on the DTO / `displayTitle` null).

- [ ] **Step 3: Extend the DTO**

In `shared/dashboard.ts`, `MyWorkPr` gains (after `summary`):

```ts
  what: string | null; // structured "What changed" (null → render falls back to summary prose)
  why: string | null; // motivation, only when the PR body stated one
```

- [ ] **Step 4: Project the real values**

In `src/tools/mywork.ts`, update the file-top comment's `(+ pr_summaries, people)` to `(+ pr_summaries, issue_summaries, people)`, then:

```ts
interface PrEventJoinRow extends EventRow {
  summary: string | null;
  s_title: string | null;
  s_what: string | null;
  s_why: string | null;
  s_impact: string | null;
}

interface RawPr {
  pr: { number: number; title: string; html_url: string; merged: boolean; base?: { ref: string } | null };
}

interface RawIssue {
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    updated_at: string;
    assignees: { login: string }[];
    labels: string[];
    milestone?: { title?: string | null; due_on?: string | null } | null;
  };
}

interface IssueSnapshotRow {
  ref_number: number;
  raw: string;
  summary: string | null;
  s_title: string | null;
  s_next_step: string | null;
}
```

PR query select-list becomes:

```sql
SELECT e.*, s.summary AS summary, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact
```

PR mapping (replacing the three placeholder nulls and their comment):

```ts
      return {
        number: parsed.pr.number,
        title: parsed.pr.title,
        url: parsed.pr.html_url,
        merged: parsed.pr.merged,
        occurredAt: row.occurred_at ?? row.recorded_at,
        summary: row.summary,
        displayTitle: row.s_title,
        what: row.s_what,
        why: row.s_why,
        impact: row.s_impact,
        baseRef: parsed.pr.base?.ref ?? null,
      };
```

Issue query select-list becomes:

```sql
SELECT e.ref_number, e.raw, s.summary AS summary, s.title AS s_title, s.next_step AS s_next_step
```

Issue mapping (replacing the three placeholder nulls and their comment):

```ts
      const m = issue.milestone;
      todo.push({
        number: issue.number,
        title: stripPriority(issue.title),
        priority: priorityOf(issue.title),
        labels: issue.labels,
        url: issue.html_url,
        updatedAt: issue.updated_at,
        summary: row.summary,
        displayTitle: row.s_title,
        // legacy raws captured before 0018 lack a milestone title — hide the row.
        milestone: m?.title ? { title: m.title, dueOn: m.due_on ?? null } : null,
        nextStep: row.s_next_step,
      });
```

- [ ] **Step 5: Keep the render tests compiling**

In `test/render.mywork.test.ts`, the `makePr` factory's base object gains `what: null, why: null` (next to `impact: null`). No behavioral render changes yet.

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/mywork.test.ts test/render.mywork.test.ts` — Expected: PASS.
Run: `npm test && npm run typecheck && npm run build:web` — Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add shared/dashboard.ts src/tools/mywork.ts test/mywork.test.ts test/render.mywork.test.ts
git commit -m "feat(mywork): project structured summary columns, milestone, and base.ref into the dashboard DTO"
```

---

### Task 7: Render from DTO fields; delete the regex convention

**Files:**
- Modify: `web/src/render.ts` (import ~line 10, `prActivityCard` ~lines 1103-1128)
- Delete: `shared/prSummary.ts`, `test/prSummary.test.ts`
- Test: `test/render.mywork.test.ts` (structured-row tests move from marker-summaries to DTO fields)

**Interfaces:**
- Consumes: Task 6's `MyWorkPr.what/why`.
- Produces: the final render contract — `what !== null` → "What changed" (+ "Why" when set) rows; `what === null && summary !== null` → one "Summary" prose row; both null → the muted no-summary line. Nothing in the web ever parses summary text again.

- [ ] **Step 1: Rewrite the render tests that used marker summaries**

In `test/render.mywork.test.ts`, the three tests around lines 101-125 become:

```ts
  it("renders What changed and Why rows from the structured DTO fields", () => {
    const pr = makePr({ what: "Fixed the login bug.", why: "Users were logged out unexpectedly." });
    const html = prActivityCard(pr, mockMd);
    expect(html).toContain("What changed");
    expect(html).toContain("Fixed the login bug.");
    expect(html).toContain("Why");
    expect(html).toContain("Users were logged out unexpectedly.");
    expect(html).not.toContain(">Summary<");
  });

  it("renders What changed without a Why row when why is null", () => {
    const html = prActivityCard(makePr({ what: "Fixed the login bug.", why: null }), mockMd);
    expect(html).toContain("What changed");
    expect(html).not.toContain(">Why<");
  });

  it("falls back to a single Summary prose row when what is null", () => {
    const html = prActivityCard(makePr({ what: null, summary: "Fixed the login bug that was affecting users." }), mockMd);
    expect(html).toContain("Summary");
    expect(html).toContain("Fixed the login bug that was affecting users.");
    expect(html).not.toContain("What changed");
  });
```

(Keep the existing null-summary muted-line test; it now needs `what: null` too if `makePr`'s default isn't already null — it is, per Task 6 Step 5. Adjust the exact not-contains label matchers to the file's existing assertion style if `>Summary<` doesn't match the produced markup — assert on the label string the row actually renders.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/render.mywork.test.ts`
Expected: the rewritten tests FAIL (fields ignored; card still parses `summary`).

- [ ] **Step 3: Rewire `prActivityCard`**

In `web/src/render.ts`, delete the `import { parseStructuredSummary } from "@shared/prSummary";` line (match its exact current form), then replace the row-building block at the top of `prActivityCard`:

```ts
export function prActivityCard(pr: MyWorkPr, markdownFn: (body: string) => string): string {
  const rows: string[] = [];
  if (pr.what !== null) {
    rows.push(mwRow("What changed", mwMdBody(pr.what, markdownFn)));
    if (pr.why) rows.push(mwRow("Why", mwMdBody(pr.why, markdownFn)));
  } else if (pr.summary === null) {
    rows.push(mwRow("Summary", `<div style="font-size:13.5px;color:var(--fg-55);line-height:1.6">${linkifyRefs("No summary recorded for this PR.")}</div>`));
  } else {
    rows.push(mwRow("Summary", mwMdBody(pr.summary, markdownFn)));
  }
  if (pr.impact) rows.push(mwRow("Impact", mwMdBody(pr.impact, markdownFn)));
```

(The `const structured = …parseStructuredSummary…` line and the old if/else disappear; everything from `const chip` down is unchanged.) Update the function's doc comment: "What changed"/"Why" come from the structured DTO fields; prose/legacy summaries render one Summary row.

- [ ] **Step 4: Delete the convention**

```bash
rm shared/prSummary.ts test/prSummary.test.ts
grep -rn "prSummary" src web shared test
```

Expected: the grep returns nothing.

- [ ] **Step 5: Run everything**

Run: `npx vitest run test/render.mywork.test.ts` — Expected: PASS.
Run: `npm test && npm run typecheck && npm run build:web` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A web/src/render.ts shared/prSummary.ts test/prSummary.test.ts test/render.mywork.test.ts
git commit -m "feat(web): render PR cards from structured DTO fields; delete the What-changed regex convention"
```

---

### Task 8: CLAUDE.md + final end-to-end verify

**Files:**
- Modify: `CLAUDE.md` (Layout migrations list; Roadmap & My Work paragraph)

**Interfaces:** none — documentation + verification.

- [ ] **Step 1: Update CLAUDE.md**

In the Layout section's migrations line, change `then\n  \`0017_issue_summaries\` [assigned-issue summaries]).` to end `then \`0017_issue_summaries\` [assigned-issue summaries], \`0018_structured_summaries\` [structured summary columns]).` (keep the file's wrapping style).

In the Roadmap & My Work section, replace the sentence beginning "Completed PRs and assigned issues are each summarized ONCE, at capture time" with:

```
Completed PRs and assigned issues are each summarized ONCE, at capture time
(`tools/summarize.ts`: Workers AI `env.AI` emits one validated JSON object — PR:
title/what/why/impact; issue: title/summary/next_step — with a deterministic excerpt
fallback that writes prose-only rows), stored as columns on `pr_summaries` /
`issue_summaries` and regenerable via Sync (a row is "done" only when
`model != 'excerpt' AND title IS NOT NULL`) — never truth, never generated at render.
```

- [ ] **Step 2: Full verify**

Run: `npm test` — Expected: all test files pass.
Run: `npm run typecheck` — Expected: exit 0.
Run: `npm run build:web` — Expected: builds clean.

- [ ] **Step 3: Manual dev pass (real AI binding — the prompts have no automated coverage)**

Run: `CLOUDFLARE_ACCOUNT_ID=6a5f361bfafdb29f00faf0c49dd1a240 npm run dev` (the AI binding proxies remotely; this account pin is required non-interactively). Sign in, run **Sync** from the admin surface, then check My Work:
- PR cards show "What changed" (+ "Why"/"Impact" where the body supported them) and the humanized title; footer shows "into `main`" for freshly-captured PRs.
- Todo cards show Summary / Milestone (title + due date) / Next step; a vague issue shows NO Next step row (`next_step: null` — the never-invent rule).
- Rows with null data collapse; excerpt-fallback rows render a single Summary prose row.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md — structured capture-time summaries (0018)"
```
