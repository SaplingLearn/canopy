# Canopy Backend — STEPS 1–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Canopy/Sapling-Context Worker with feed-issue links (STEP 1), the human-confirm half of the staged-write model — doc promotion + ADR ratification (STEP 2) — and a milestone/roadmap layer with live GitHub progress (STEP 3), without rescaffolding the existing architecture.

**Architecture:** One Cloudflare Worker. Hono app (`src/routes.ts`) for HTTP behind a session gate; a stateless `createMcpHandler` at `/mcp` (`src/mcp.ts`) behind a bearer gate. `shared/` is the only shared layer (contract + row types + vocabulary). D1 is the store (`src/db.ts` helpers). Every write funnels through the per-entry **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` / `ingestAdrDraft`, and new `ingestMilestoneProposal`); MCP tools and `/ingest` are thin adapters over those. Human confirmations (promote / ratify / promote-milestone / complete-milestone) are authenticated **HTTP-only** routes — never MCP tools. The author on every write is the authenticated principal.

**Tech Stack:** TypeScript, Hono 4.12, `@modelcontextprotocol/sdk` 1.29, `agents` 0.16 (`agents/mcp`), zod 4, D1, Wrangler 4, Vitest 4 + `@cloudflare/vitest-pool-workers` 0.16 (Miniflare). GitHub REST API (live issue/milestone reads).

## Global Constraints

- **Do not rescaffold.** Keep the boundaries: one Worker, Hono, stateless `createMcpHandler` at `/mcp`, `shared/` the only shared layer, D1, the single gated write path, thin MCP/HTTP adapters over `src/tools`, author from the authenticated principal.
- **Verified installed versions (bind to these):** zod **4.4.3**, `@modelcontextprotocol/sdk` **1.29.0**, `agents` **0.16.2**, hono **4.12.27**, wrangler **4.104.0**, vitest **4.1.9**, `@cloudflare/vitest-pool-workers` **0.16.19**. (`package.json` floors are looser but satisfied; no bumps needed.)
- **GitHub REST shapes (verified against docs.github.com, apiVersion 2022-11-28):** `GET /repos/{owner}/{repo}/milestones/{n}` → `open_issues`, `closed_issues`, `state` ('open'|'closed'); 404 if missing. `GET /repos/{owner}/{repo}/issues/{n}` → `state` ('open'|'closed'), plus a `pull_request` key on PRs; 404/410 if missing.
- **The gate holds on every write path** including the new `propose_milestone` MCP tool. Nothing out-of-vocab / low-confidence / terminal-status is written live — it is staged or routed to `needs_triage`.
- **Human-only confirmations are HTTP routes, never MCP tools:** `promote_doc`, `ratify_adr`, `promote_milestone` (proposal→live), `complete_milestone` (live→'done'). `'done'` is never set by the worker and never inferred from 100% issue closure.
- **No new auth flow.** Reuse the existing GitHub OAuth + sessions + hashed bearer + `COOKIE_SECRET`. The org OAuth token is retained AES-GCM-sealed under `COOKIE_SECRET`.
- **Deferred seams stay deferred:** Queue, Vectorize, the GitHub OAuth provider for MCP, the issue webhook. Do not activate them.
- **Keep all 31 existing tests green** at every checkpoint. Commit after each STEP (1, then 2, then 3).

## Divergences Flagged (spec asked to flag)

1. **The gate reconcile is NOT committed** despite the prompt saying "done and committed." Working tree has modified `src/consumer.ts`, `src/mcp.ts` and untracked `test/mcp-writes.gated.test.ts`; the 31 green include those uncommitted changes. **Task 0 commits them** as the baseline checkpoint so each STEP is a clean diff.
2. **`fetchMock` is not a named export** of `@cloudflare/vitest-pool-workers` 0.16.19 (only an abstract `MockAgent` type exists; no exported instance/accessor). Therefore GitHub I/O is made **injectable** (a `fetchImpl?: typeof fetch` parameter) so the `/roadmap` progress test mocks GitHub at the `Response` level via dependency injection, not via an undocumented mock API.
3. **`github_ref` repo context:** bare milestone-number / issue-number arrays resolve against a single `GITHUB_REPO` env binding ("owner/repo"). Per-milestone qualified refs are a documented future seam, not built now.
4. **`promote_milestone` route** is the milestone analog of `promote_doc` (proposal→live). The spec implied it ("promoted/confirmed per its rules", "consistent with doc proposals") but did not name it; confirmed in planning. Live `milestones` keep the fixed 3-status enum; staging lives only in `milestone_proposals`.

## File Structure

**Created:**
- `migrations/0004_roadmap.sql` — `milestones` + `milestone_proposals` tables; `ALTER TABLE users ADD COLUMN github_token`.
- `src/tools/roadmap.ts` — `list_roadmap` (DB read, target-date order) + `fetchMilestoneProgress` (injectable GitHub REST progress reader). Roadmap-read concern.
- `test/feed-issues.test.ts` — STEP 1.
- `test/doc-promote-adr-ratify.test.ts` — STEP 2.
- `test/roadmap.test.ts` — STEP 3.

**Modified:**
- `shared/contract.ts` — `artifacts.issues` (STEP 1); `MilestoneProposal` + `IngestPayload.milestone_proposals` (STEP 3).
- `shared/rows.ts` — `UserRow.github_token`; `MilestoneRow`; `MilestoneProposalRow` (STEP 3).
- `src/mcp.ts` — `append_feed` issues passthrough (STEP 1); `propose_milestone` write tool + `get_roadmap` read tool (STEP 3).
- `src/consumer.ts` — `ingestMilestoneProposal` gate fn + `consume` loop + `IngestResult.milestones` (STEP 3).
- `src/tools/writes.ts` — `promote_doc`, `ratify_adr` (STEP 2); `stage_milestone_proposal`, `promote_milestone_proposal`, `complete_milestone` (STEP 3).
- `src/routes.ts` — promote/ratify routes (STEP 2); `/roadmap`, promote-milestone, complete-milestone routes (STEP 3).
- `src/auth/crypto.ts` — AES-GCM `encryptSecret` / `decryptSecret` + `fromBase64Url` (STEP 3).
- `src/auth/github.ts` — `storeToken` / `getStoredToken` (STEP 3).
- `src/auth/routes.ts` — seal + persist the OAuth token at callback (STEP 3).
- `src/env.ts`, `test/env.d.ts`, `wrangler.toml` — `GITHUB_REPO` binding (STEP 3).
- `test/apply-migrations.ts` — truncate `milestones`, `milestone_proposals` in `beforeEach` (STEP 3).
- `test/consumer.vocab-gate.test.ts`, `test/mcp-writes.gated.test.ts` — add `issues: []` to inline `artifacts` literals so typecheck stays clean (STEP 1).

---

## Task 0: Commit the pending gate reconcile (baseline checkpoint)

The reconcile work is in the working tree but uncommitted. Commit it verbatim so STEP 1 starts from a clean tree.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npx vitest run`
Expected: `Test Files  11 passed (11)` / `Tests  31 passed (31)`.

- [ ] **Step 2: Commit the reconcile**

```bash
git add src/consumer.ts src/mcp.ts test/mcp-writes.gated.test.ts
git commit -m "$(cat <<'EOF'
refactor(gate): extract per-entry gate functions; MCP writes funnel through them

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify clean tree**

Run: `git status --porcelain`
Expected: empty output.

---

## STEP 1 — Issues on feed artifacts

### Task 1: Add `issues: number[]` to the FeedEntry artifacts contract and pass it through `append_feed`

**Files:**
- Modify: `shared/contract.ts:13-16` (artifacts object)
- Modify: `src/mcp.ts:49-62` (append_feed adapter)
- Modify: `test/consumer.vocab-gate.test.ts:16-18`, `test/mcp-writes.gated.test.ts:17,33` (inline artifacts literals)
- Test: `test/feed-issues.test.ts` (create)

**Interfaces:**
- Consumes: `ingestFeedEntry(db, entry: FeedEntry, author: string)` (existing gate fn) → writes `entry.artifacts` as JSON via `append_feed`.
- Produces: `FeedEntry.artifacts.issues: number[]` (default `[]`); MCP `append_feed` accepts optional `issues: number[]`.

- [ ] **Step 1: Write the failing test**

Create `test/feed-issues.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { FeedEntry } from "@shared/contract";
import { ingestFeedEntry } from "../src/consumer";
import { all } from "../src/db";
import type { FeedRow } from "@shared/rows";

describe("feed entry issue links", () => {
  it("defaults artifacts.issues to [] when omitted", () => {
    const parsed = FeedEntry.parse({ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } });
    expect(parsed.artifacts.issues).toEqual([]);
  });

  it("round-trips issues:[42] into the stored feed artifacts json", async () => {
    const r = await ingestFeedEntry(
      env.DB,
      { summary: "linked", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [42] } },
      "andres"
    );
    expect(r.outcome).toBe("written");

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    const artifacts = JSON.parse(feed[0].artifacts!);
    expect(artifacts.issues).toEqual([42]);
    expect(artifacts.prs).toEqual([]);
    expect(artifacts.commits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/feed-issues.test.ts`
Expected: FAIL — first test fails because `artifacts.issues` is `undefined` (contract has no `issues` field yet).

- [ ] **Step 3: Add `issues` to the contract**

In `shared/contract.ts`, replace the `artifacts` object inside `FeedEntry`:

```ts
  artifacts: z.object({
    prs: z.array(z.string()).default([]),
    commits: z.array(z.string()).default([]),
    issues: z.array(z.number()).default([]),
  }),
```

- [ ] **Step 4: Pass `issues` through the MCP `append_feed` adapter**

In `src/mcp.ts`, replace the `append_feed` tool registration (the `server.tool("append_feed", ...)` block) with:

```ts
  server.tool(
    "append_feed",
    "Append a feed entry through the vocabulary gate (an out-of-vocab tag routes the entry to needs_triage). Optional issues link GitHub issue numbers.",
    { summary: z.string(), body: z.string().optional(), tags: z.array(z.string()).optional(), issues: z.array(z.number()).optional() },
    async ({ summary, body, tags, issues }) =>
      // Thin adapter: shape the args into a FeedEntry and let the gate decide write-vs-triage.
      runTool(() =>
        ingestFeedEntry(
          env.DB,
          { summary, body: body ?? "", tags: tags ?? [], artifacts: { prs: [], commits: [], issues: issues ?? [] } },
          principal.login
        )
      )
  );
```

- [ ] **Step 5: Keep existing inline `artifacts` literals type-clean**

The inferred `FeedEntry.artifacts` now requires `issues`. Add `issues: []` to the inline literals in the two existing tests (runtime-neutral, keeps `npm run typecheck` clean).

In `test/consumer.vocab-gate.test.ts`, the two feed entries become:
```ts
        { summary: "known", body: "good", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [] } },
        { summary: "unknown", body: "bad", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [], issues: [] } },
```

In `test/mcp-writes.gated.test.ts`, the two `ingestFeedEntry` calls' artifacts become:
```ts
      { summary: "ok", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [] } },
```
```ts
      { summary: "bad", body: "b", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [], issues: [] } },
```

(Verify no other inline artifacts literals exist: `grep -rn "artifacts: {" src test`. The `/ingest` JSON-string body in `test/auth-gate.test.ts` is parsed at runtime and needs no change.)

- [ ] **Step 6: Run the new test + full suite**

Run: `npx vitest run test/feed-issues.test.ts`
Expected: PASS (2 tests).

Run: `npx vitest run`
Expected: `Tests  33 passed (33)` (31 existing + 2 new).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit STEP 1**

```bash
git add shared/contract.ts src/mcp.ts test/feed-issues.test.ts test/consumer.vocab-gate.test.ts test/mcp-writes.gated.test.ts
git commit -m "$(cat <<'EOF'
feat(feed): add issues[] to feed artifacts and pass through append_feed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## STEP 2 — Doc promotion + ADR ratification

### Task 2: `promote_doc` and `ratify_adr` writer functions

**Files:**
- Modify: `src/tools/writes.ts` (append two functions at end)
- Test: `test/doc-promote-adr-ratify.test.ts` (create; function-level cases)

**Interfaces:**
- Consumes: `DocVersionRow`, `AdrRow` (from `@shared/rows`); `first`, `run`, `nowIso` (from `../db`).
- Produces:
  - `promote_doc(db: DB, slug: string, version: number, author: string): Promise<{ slug: string; version: number; status: "promoted" }>` — sets that `doc_versions` row `status='promoted'`, copies its body into `docs.body`, bumps `docs.current_version` to `version`, sets `updated_at`/`updated_by`. Non-destructive (prior versions remain). Throws if the version doesn't exist or isn't `'staged'`.
  - `ratify_adr(db: DB, id: number): Promise<{ id: number; status: "ratified" }>` — sets the adr `status='ratified'`. Throws if missing or already ratified.

- [ ] **Step 1: Write the failing test**

Create `test/doc-promote-adr-ratify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { propose_doc_update, stage_adr, promote_doc, ratify_adr } from "../src/tools/writes";
import { first } from "../src/db";
import type { DocRow, DocVersionRow, AdrRow } from "@shared/rows";

const base = { slug: "architecture", section: "reference", title: "Architecture", confidence: "high" as const };

describe("promote_doc", () => {
  it("flips the version to promoted, copies body into docs, bumps current_version, keeps prior versions", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await propose_doc_update(env.DB, { ...base, body: "# v2", change_summary: "second" }, "andres");

    const out = await promote_doc(env.DB, "architecture", 2, "andres");
    expect(out).toEqual({ slug: "architecture", version: 2, status: "promoted" });

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(2);
    expect(doc?.body).toBe("# v2");
    expect(doc?.updated_by).toBe("andres");

    const v1 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 1`, "architecture");
    const v2 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 2`, "architecture");
    expect(v1?.status).toBe("staged");   // prior version intact, untouched
    expect(v1?.body).toBe("# v1");
    expect(v2?.status).toBe("promoted");
  });

  it("rejects a version that does not exist", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await expect(promote_doc(env.DB, "architecture", 99, "andres")).rejects.toThrow();
  });

  it("rejects promoting an already-promoted (non-staged) version", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    await promote_doc(env.DB, "architecture", 1, "andres");
    await expect(promote_doc(env.DB, "architecture", 1, "andres")).rejects.toThrow();
  });
});

describe("ratify_adr", () => {
  it("flips a draft to ratified", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const out = await ratify_adr(env.DB, id);
    expect(out).toEqual({ id, status: "ratified" });
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("ratified");
  });

  it("rejects a missing adr", async () => {
    await expect(ratify_adr(env.DB, 4242)).rejects.toThrow();
  });

  it("rejects an already-ratified adr", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    await ratify_adr(env.DB, id);
    await expect(ratify_adr(env.DB, id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/doc-promote-adr-ratify.test.ts`
Expected: FAIL — `promote_doc`/`ratify_adr` are not exported.

- [ ] **Step 3: Implement the two writers**

Append to `src/tools/writes.ts`. First ensure the import line at the top includes the row types used:

```ts
import type { DocRow, DocVersionRow, AdrRow } from "@shared/rows";
```
(`DocRow` is already imported; add `DocVersionRow, AdrRow`.)

Then append:

```ts
/**
 * Human confirmation: promote a staged doc version into the live doc.
 * Non-destructive — prior versions remain. Rejects if the version is missing or not staged.
 */
export async function promote_doc(
  db: DB,
  slug: string,
  version: number,
  author: string
): Promise<{ slug: string; version: number; status: "promoted" }> {
  const ver = await first<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? AND version = ?`,
    slug,
    version
  );
  if (!ver) throw new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status !== "staged") throw new Error(`doc version not staged: ${slug} v${version} is ${ver.status}`);

  const updated_at = nowIso();
  await run(db, `UPDATE doc_versions SET status = 'promoted' WHERE slug = ? AND version = ?`, slug, version);
  await run(
    db,
    `UPDATE docs SET body = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE slug = ?`,
    ver.body,
    version,
    updated_at,
    author,
    slug
  );
  return { slug, version, status: "promoted" };
}

/** Human confirmation: ratify an ADR draft. Rejects if missing or already ratified. */
export async function ratify_adr(db: DB, id: number): Promise<{ id: number; status: "ratified" }> {
  const adr = await first<AdrRow>(db, `SELECT * FROM adrs WHERE id = ?`, id);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "ratified") throw new Error(`adr already ratified: ${id}`);
  await run(db, `UPDATE adrs SET status = 'ratified' WHERE id = ?`, id);
  return { id, status: "ratified" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/doc-promote-adr-ratify.test.ts`
Expected: PASS (6 tests).

### Task 3: Expose promote/ratify as authenticated HTTP routes

**Files:**
- Modify: `src/routes.ts` (imports + two POST routes)
- Test: `test/doc-promote-adr-ratify.test.ts` (append route-wiring cases)

**Interfaces:**
- Consumes: `promote_doc`, `ratify_adr` (Task 2); `app` Hono instance, `sessionGate` already applied; `c.get("principal")` for the author.
- Produces: `POST /doc/:slug/promote` (JSON body `{ version: number }`) and `POST /adr/:id/ratify`. Both session-gated. 200 `{ ok: true, ... }` on success; 400 `{ error }` on invalid input.

- [ ] **Step 1: Write the failing route test (append to the existing STEP 2 file)**

Append to `test/doc-promote-adr-ratify.test.ts`:

```ts
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { stage_adr as _stage } from "../src/tools/writes"; // alias to avoid name clash if needed

async function authedCookie(login: string): Promise<string> {
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("promote/ratify HTTP routes (session-gated)", () => {
  it("POST /doc/:slug/promote promotes for an authenticated principal", async () => {
    await propose_doc_update(env.DB, { ...base, body: "# v1", change_summary: "first" }, "andres");
    const cookie = await authedCookie("andres");
    const res = await app.request(
      "/doc/architecture/promote",
      { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) },
      env
    );
    expect(res.status).toBe(200);
    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(1);
  });

  it("POST /adr/:id/ratify is rejected with 401 without a session", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const res = await app.request(`/adr/${id}/ratify`, { method: "POST" }, env);
    expect(res.status).toBe(401);
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("draft"); // unchanged
  });

  it("POST /adr/:id/ratify ratifies for an authenticated principal", async () => {
    const id = await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const cookie = await authedCookie("andres");
    const res = await app.request(`/adr/${id}/ratify`, { method: "POST", headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("ratified");
  });
});
```

(Remove the unused `_stage` alias import if your linter flags it; it is only there to illustrate import style — `stage_adr` is already imported at the top of the file. Keep the top import; drop this redundant line.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/doc-promote-adr-ratify.test.ts`
Expected: FAIL — routes return 404 (not registered).

- [ ] **Step 3: Add the routes**

In `src/routes.ts`, extend the writes import:
```ts
import { promote_doc, ratify_adr } from "./tools/writes";
```
(Add it; `consume` and the reads imports stay.)

Append after the existing `/search` route:

```ts
// Human confirmation (session-gated): promote a staged doc version into the live doc.
app.post("/doc/:slug/promote", async (c) => {
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try {
    const res = await promote_doc(c.env.DB, c.req.param("slug"), version, c.get("principal").login);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human confirmation (session-gated): ratify an ADR draft.
app.post("/adr/:id/ratify", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await ratify_adr(c.env.DB, id);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
```

- [ ] **Step 4: Run the file + full suite + typecheck**

Run: `npx vitest run test/doc-promote-adr-ratify.test.ts`
Expected: PASS (9 tests).

Run: `npx vitest run`
Expected: `Tests  42 passed (42)` (33 + 9 new).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit STEP 2**

```bash
git add src/tools/writes.ts src/routes.ts test/doc-promote-adr-ratify.test.ts
git commit -m "$(cat <<'EOF'
feat(staged-write): add doc promotion and ADR ratification as human HTTP routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## STEP 3 — Milestone / Roadmap layer

### Task 4: Schema, row types, contract, and test truncation

**Files:**
- Create: `migrations/0004_roadmap.sql`
- Modify: `shared/rows.ts` (`UserRow.github_token`; add `MilestoneRow`, `MilestoneProposalRow`)
- Modify: `shared/contract.ts` (`MilestoneProposal`, `IngestPayload.milestone_proposals`, exported types)
- Modify: `test/apply-migrations.ts` (truncate new tables)

**Interfaces:**
- Produces:
  - Tables `milestones(id, title, description, target_date, status, github_ref, created_at, created_by, updated_at)` and `milestone_proposals(id, title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by)`; `users.github_token` (nullable, AES-GCM-sealed).
  - `MilestoneRow`, `MilestoneProposalRow` row types; `UserRow.github_token: string | null`.
  - Contract `MilestoneProposal` (`title`, `target_date`, `status` enum, `github_ref` optional `number | number[]`, `change_summary`, `confidence`) and `IngestPayload.milestone_proposals: MilestoneProposal[]` (default `[]`).

- [ ] **Step 1: Create the migration**

Create `migrations/0004_roadmap.sql`:

```sql
-- Live, human-confirmed roadmap milestones. Coarse goals, not tickets.
-- No issue/progress state is stored here; progress is computed live from GitHub at read time.
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  target_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming',   -- 'upcoming' | 'in_progress' | 'done'
  github_ref TEXT,                            -- JSON: a milestone number OR an array of issue numbers
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT
);

-- Agent-proposed milestone create/update, staged for human review (mirrors doc_versions → docs).
CREATE TABLE milestone_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  target_date TEXT NOT NULL,
  status TEXT NOT NULL,                        -- proposed status; the gate rejects 'done'
  github_ref TEXT,
  change_summary TEXT NOT NULL,
  confidence TEXT NOT NULL,
  staged_status TEXT NOT NULL DEFAULT 'staged', -- 'staged' | 'promoted'
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX idx_milestones_target_date ON milestones(target_date);

-- Retain the GitHub OAuth token (AES-GCM sealed under COOKIE_SECRET) for live roadmap progress.
ALTER TABLE users ADD COLUMN github_token TEXT;
```

- [ ] **Step 2: Add row types**

In `shared/rows.ts`, add `github_token` to `UserRow`:
```ts
export interface UserRow {
  github_login: string;
  name: string | null;
  github_token: string | null;   // AES-GCM sealed GitHub OAuth token, or null
  created_at: string;
}
```

Append the two new row types:
```ts
export interface MilestoneRow {
  id: number;
  title: string;
  description: string | null;
  target_date: string;
  status: "upcoming" | "in_progress" | "done";
  github_ref: string | null;   // JSON: number (milestone) | number[] (issues)
  created_at: string;
  created_by: string;
  updated_at: string | null;
}

export interface MilestoneProposalRow {
  id: number;
  title: string;
  target_date: string;
  status: string;
  github_ref: string | null;
  change_summary: string;
  confidence: string;
  staged_status: "staged" | "promoted";
  created_at: string;
  created_by: string;
}
```

- [ ] **Step 3: Add the contract**

In `shared/contract.ts`, add before `IngestPayload`:
```ts
export const MilestoneProposal = z.object({
  title: z.string(),
  target_date: z.string(),
  status: z.enum(["upcoming", "in_progress", "done"]),
  github_ref: z.union([z.number(), z.array(z.number())]).optional(),
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
});
```

Add the field to `IngestPayload`:
```ts
  milestone_proposals: z.array(MilestoneProposal).default([]),
```

Add the exported type (next to the other `z.infer` exports):
```ts
export type MilestoneProposal = z.infer<typeof MilestoneProposal>;
```

- [ ] **Step 4: Truncate the new tables between tests**

In `test/apply-migrations.ts`, extend the `beforeEach` `DELETE` chain to include the new tables (before `sessions`):
```ts
    "DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
```

- [ ] **Step 5: Verify the migration applies and the suite is still green**

Run: `npx vitest run`
Expected: `Tests  42 passed (42)` — schema additions are inert so far; migration applies cleanly via `applyD1Migrations`.

### Task 5: AES-GCM secret sealing + GitHub token retention

**Files:**
- Modify: `src/auth/crypto.ts` (add `fromBase64Url`, `encryptSecret`, `decryptSecret`)
- Modify: `src/auth/github.ts` (add `storeToken`, `getStoredToken`)
- Modify: `src/auth/routes.ts` (seal + persist token at callback)
- Test: `test/roadmap.test.ts` (create; crypto + token round-trip cases)

**Interfaces:**
- Produces:
  - `encryptSecret(plaintext: string, secret: string): Promise<string>` and `decryptSecret(sealed: string, secret: string): Promise<string | null>` (AES-256-GCM, key = SHA-256(secret), 12-byte random IV prepended, base64url; `decryptSecret` returns `null` on any failure).
  - `storeToken(db: DB, login: string, token: string, secret: string): Promise<void>` — seals and writes `users.github_token`.
  - `getStoredToken(db: DB, login: string, secret: string): Promise<string | null>` — reads + decrypts; `null` if no row / no token / undecryptable.

- [ ] **Step 1: Write the failing test**

Create `test/roadmap.test.ts` (more cases appended in later tasks):

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { encryptSecret, decryptSecret } from "../src/auth/crypto";
import { storeToken, getStoredToken } from "../src/auth/github";
import { run, nowIso } from "../src/db";

const SECRET = "test-cookie-secret";

describe("AES-GCM secret sealing", () => {
  it("round-trips a value and fails closed on a wrong secret / garbage", async () => {
    const sealed = await encryptSecret("gho_secret_token", SECRET);
    expect(sealed).not.toContain("gho_secret_token");
    expect(await decryptSecret(sealed, SECRET)).toBe("gho_secret_token");
    expect(await decryptSecret(sealed, "wrong-secret")).toBeNull();
    expect(await decryptSecret("not-valid", SECRET)).toBeNull();
  });
});

describe("GitHub token retention", () => {
  it("stores a sealed token and reads it back for the principal; null when absent", async () => {
    await run(env.DB, `INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`, "andres", null, nowIso());
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBeNull();

    await storeToken(env.DB, "andres", "gho_live_token", SECRET);
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBe("gho_live_token");
    expect(await getStoredToken(env.DB, "nobody", SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/roadmap.test.ts`
Expected: FAIL — `encryptSecret`/`storeToken` not exported.

- [ ] **Step 3: Add AES-GCM helpers to crypto**

In `src/auth/crypto.ts`, add a `fromBase64Url` helper after `toBase64Url`:
```ts
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

Append at the end of the file:
```ts
/** AES-256-GCM key derived from a secret (SHA-256 → 32-byte key). */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seal a secret value at rest: base64url(iv ‖ AES-GCM ciphertext). */
export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return toBase64Url(packed);
}

/** Open a sealed secret; null if malformed, tampered, or sealed with another secret. */
export async function decryptSecret(sealed: string, secret: string): Promise<string | null> {
  try {
    const packed = fromBase64Url(sealed);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(secret), ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add token store/load to `src/auth/github.ts`**

At the top of `src/auth/github.ts`, add imports:
```ts
import { type DB, first, run } from "../db";
import { encryptSecret, decryptSecret } from "./crypto";
```

Append at the end:
```ts
/** Persist the principal's GitHub OAuth token, sealed at rest under `secret`. */
export async function storeToken(db: DB, login: string, token: string, secret: string): Promise<void> {
  const sealed = await encryptSecret(token, secret);
  await run(db, `UPDATE users SET github_token = ? WHERE github_login = ?`, sealed, login);
}

/** Load + decrypt the principal's GitHub OAuth token; null if absent or undecryptable. */
export async function getStoredToken(db: DB, login: string, secret: string): Promise<string | null> {
  const row = await first<{ github_token: string | null }>(
    db,
    `SELECT github_token FROM users WHERE github_login = ?`,
    login
  );
  if (!row?.github_token) return null;
  return decryptSecret(row.github_token, secret);
}
```

- [ ] **Step 5: Seal + persist the token at the OAuth callback**

In `src/auth/routes.ts`, the `/callback` handler already has the GitHub access token in scope as `token` (from `exchangeCode`). Replace the user-upsert block so it also seals and stores that token. Replace:
```ts
  await run(c.env.DB,
    `INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET name = excluded.name`,
    ghUser.login, ghUser.name, nowIso());
```
with:
```ts
  const sealedToken = await encryptSecret(token, c.env.COOKIE_SECRET);
  await run(c.env.DB,
    `INSERT INTO users (github_login, name, github_token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET name = excluded.name, github_token = excluded.github_token`,
    ghUser.login, ghUser.name, sealedToken, nowIso());
```
And add `encryptSecret` to the crypto import at the top of `src/auth/routes.ts`:
```ts
import { pkce, randomToken, hmacSeal, hmacUnseal, encryptSecret } from "./crypto";
```

- [ ] **Step 6: Run the test + full suite + typecheck**

Run: `npx vitest run test/roadmap.test.ts`
Expected: PASS (2 tests so far).

Run: `npx vitest run`
Expected: `Tests  44 passed (44)`.

Run: `npm run typecheck`
Expected: no errors.

### Task 6: Milestone gate + staging writer + `consume` wiring

**Files:**
- Modify: `src/tools/writes.ts` (`stage_milestone_proposal`)
- Modify: `src/consumer.ts` (`MilestoneIngestResult`, `ingestMilestoneProposal`, `IngestResult.milestones`, `consume` loop)
- Test: `test/roadmap.test.ts` (append gate cases)

**Interfaces:**
- Consumes: `MilestoneProposal` (contract); `first`, `run`, `nowIso`.
- Produces:
  - `stage_milestone_proposal(db: DB, proposal: MilestoneProposal, author: string): Promise<number>` — inserts a `milestone_proposals` row (`staged_status='staged'`), `github_ref` JSON-encoded or null; returns the row id.
  - `ingestMilestoneProposal(db: DB, proposal: MilestoneProposal, author: string): Promise<MilestoneIngestResult>` where `MilestoneIngestResult = { outcome: "written"; id: number } | { outcome: "triaged"; reason: string }`. Routes to triage when `status === 'done'` (completion is a human action) or `confidence === 'low'`; otherwise stages.
  - `IngestResult` gains `milestones: number`; `consume` loops `payload.milestone_proposals`.

- [ ] **Step 1: Write the failing test (append to `test/roadmap.test.ts`)**

```ts
import { IngestPayload } from "@shared/contract";
import { ingestMilestoneProposal, consume } from "../src/consumer";
import { all } from "../src/db";
import type { MilestoneProposalRow, MilestoneRow, NeedsTriageRow } from "@shared/rows";

const sessionMeta = { author: "x", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" };

describe("milestone proposal gate", () => {
  it("stages a valid proposal; it is NOT a live milestone until promoted", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", github_ref: [1, 2], change_summary: "kickoff", confidence: "high" },
      "andres"
    );
    expect(r.outcome).toBe("written");

    const staged = await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`);
    expect(staged.length).toBe(1);
    expect(staged[0].staged_status).toBe("staged");
    expect(JSON.parse(staged[0].github_ref!)).toEqual([1, 2]);

    const live = await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`);
    expect(live.length).toBe(0); // not live until the human promote route runs
  });

  it("routes a 'done'-status proposal to triage (completion is a human action)", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "Done?", target_date: "2026-09-01", status: "done", change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(r.outcome).toBe("triaged");
    expect(await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).toHaveLength(0);
    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage[0].reason).toContain("completion");
  });

  it("routes a low-confidence proposal to triage", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "Maybe", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "low" },
      "andres"
    );
    expect(r.outcome).toBe("triaged");
    expect(await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).toHaveLength(0);
  });

  it("/ingest funnels milestone_proposals through the same gate and stages them", async () => {
    const payload = IngestPayload.parse({
      session: sessionMeta,
      milestone_proposals: [
        { title: "GA", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "high" },
      ],
    });
    const result = await consume(env.DB, payload, { login: "andres" });
    expect(result.milestones).toBe(1);
    const staged = await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`);
    expect(staged.length).toBe(1);
    expect(staged[0].created_by).toBe("andres"); // author from principal, not session
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/roadmap.test.ts`
Expected: FAIL — `ingestMilestoneProposal` / `result.milestones` not present.

- [ ] **Step 3: Add the staging writer**

Append to `src/tools/writes.ts`:
```ts
/** Stage an agent-proposed milestone create/update for human review (mirrors doc_versions). */
export async function stage_milestone_proposal(
  db: DB,
  proposal: { title: string; target_date: string; status: string; github_ref?: number | number[]; change_summary: string; confidence: "high" | "low" },
  author: string
): Promise<number> {
  const github_ref = proposal.github_ref === undefined ? null : JSON.stringify(proposal.github_ref);
  const res = await run(
    db,
    `INSERT INTO milestone_proposals (title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
    proposal.title,
    proposal.target_date,
    proposal.status,
    github_ref,
    proposal.change_summary,
    proposal.confidence,
    nowIso(),
    author
  );
  return res.meta.last_row_id as number;
}
```

- [ ] **Step 4: Add the gate fn + wire `consume`**

In `src/consumer.ts`:

Extend the contract import:
```ts
import type { IngestPayload, FeedEntry, DocProposal, AdrDraft, MilestoneProposal } from "@shared/contract";
```
Extend the writes import:
```ts
import { append_feed, propose_doc_update, stage_adr, route_triage, stage_milestone_proposal } from "./tools/writes";
```
Add `milestones` to `IngestResult`:
```ts
export interface IngestResult {
  feed: number;
  docs: number;
  adrs: number;
  milestones: number;
  triaged: number;
}
```
Add the result type next to the others:
```ts
export type MilestoneIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "triaged"; reason: string };
```
Add the gate fn after `ingestAdrDraft`:
```ts
/** Milestones: 'done' (completion is a human action) and low confidence route to triage; otherwise staged for human promotion. */
export async function ingestMilestoneProposal(
  db: DB,
  proposal: MilestoneProposal,
  author: string
): Promise<MilestoneIngestResult> {
  if (proposal.status === "done") {
    const reason = "milestone completion is a human action";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  if (proposal.confidence === "low") {
    const reason = "low confidence milestone proposal";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  const id = await stage_milestone_proposal(db, proposal, author);
  return { outcome: "written", id };
}
```
Initialize the counter and add the loop in `consume`. Change the result initializer:
```ts
  const result: IngestResult = { feed: 0, docs: 0, adrs: 0, milestones: 0, triaged: 0 };
```
Add after the `adr_drafts` loop (before the explicit `needs_triage` loop):
```ts
  for (const proposal of payload.milestone_proposals) {
    const r = await ingestMilestoneProposal(db, proposal, author);
    if (r.outcome === "written") result.milestones++;
    else result.triaged++;
  }
```

- [ ] **Step 5: Run the file + full suite + typecheck**

Run: `npx vitest run test/roadmap.test.ts`
Expected: PASS (6 tests so far).

Run: `npx vitest run`
Expected: `Tests  48 passed (48)`.

Run: `npm run typecheck`
Expected: no errors.

### Task 7: Roadmap read + live GitHub progress (injectable) + promote/complete writers

**Files:**
- Create: `src/tools/roadmap.ts`
- Modify: `src/tools/writes.ts` (`promote_milestone_proposal`, `complete_milestone`)
- Test: `test/roadmap.test.ts` (append read/progress/promote/complete cases)

**Interfaces:**
- Produces:
  - `fetchMilestoneProgress(opts: { token: string; repo: string; ref: string; fetchImpl?: typeof fetch }): Promise<{ closed: number; total: number } | null>` — parses `ref` (JSON): an array → per-issue `GET /repos/{repo}/issues/{n}` counting `state === "closed"`; a number → `GET /repos/{repo}/milestones/{n}` using `closed_issues` / `open_issues+closed_issues`. Returns `null` on parse failure, non-OK response, or any throw (never throws). `fetchImpl` defaults to global `fetch`.
  - `MilestoneWithProgress = MilestoneRow & { progress: { closed: number; total: number } | null }`.
  - `list_roadmap(db: DB, opts?: { token?: string | null; repo?: string; fetchImpl?: typeof fetch }): Promise<MilestoneWithProgress[]>` — milestones in `target_date ASC, id ASC`; when `token` or `repo` is missing, every `progress` is `null` (clean fallback seam); reads only, stores nothing.
  - `promote_milestone_proposal(db: DB, id: number, author: string): Promise<MilestoneRow>` — creates a live milestone from a staged proposal, marks the proposal `staged_status='promoted'`. Throws if the proposal is missing or already promoted. (Proposal `status` is never `'done'` — the gate guaranteed it — so promotion never produces a 'done' milestone.)
  - `complete_milestone(db: DB, id: number): Promise<MilestoneRow>` — sets a live milestone `status='done'`, `updated_at`. Throws if missing or already done.

- [ ] **Step 1: Write the failing test (append to `test/roadmap.test.ts`)**

```ts
import { list_roadmap, fetchMilestoneProgress } from "../src/tools/roadmap";
import { promote_milestone_proposal, complete_milestone, stage_milestone_proposal } from "../src/tools/writes";
import { first } from "../src/db";

// A stub `fetch` returning canned GitHub issue/milestone JSON, keyed by URL.
function stubFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchMilestoneProgress", () => {
  it("counts closed vs total across an issue-number array", async () => {
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/2": { state: "open" } });
    const p = await fetchMilestoneProgress({ token: "t", repo: "o/r", ref: "[1,2]", fetchImpl });
    expect(p).toEqual({ closed: 1, total: 2 });
  });

  it("reads counts directly from a milestone object", async () => {
    const fetchImpl = stubFetch({ "/milestones/5": { open_issues: 3, closed_issues: 7, state: "open" } });
    const p = await fetchMilestoneProgress({ token: "t", repo: "o/r", ref: "5", fetchImpl });
    expect(p).toEqual({ closed: 7, total: 10 });
  });

  it("falls back to null on a non-OK GitHub response (expired/revoked token), never throws", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const p = await fetchMilestoneProgress({ token: "stale", repo: "o/r", ref: "[1]", fetchImpl });
    expect(p).toBeNull();
  });
});

describe("promote_milestone_proposal + complete_milestone", () => {
  it("promotes a staged proposal into a live milestone (and not before)", async () => {
    const pid = await stage_milestone_proposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", github_ref: [1, 2], change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`)).toHaveLength(0);

    const m = await promote_milestone_proposal(env.DB, pid, "andres");
    expect(m.status).toBe("in_progress");
    expect(m.title).toBe("GA");

    const proposal = await first<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals WHERE id = ?`, pid);
    expect(proposal?.staged_status).toBe("promoted");
    await expect(promote_milestone_proposal(env.DB, pid, "andres")).rejects.toThrow(); // no double-promote
  });

  it("complete_milestone flips a live milestone to 'done'; rejects missing/already-done", async () => {
    const pid = await stage_milestone_proposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", change_summary: "s", confidence: "high" },
      "andres"
    );
    const m = await promote_milestone_proposal(env.DB, pid, "andres");
    const done = await complete_milestone(env.DB, m.id);
    expect(done.status).toBe("done");
    const row = await first<MilestoneRow>(env.DB, `SELECT * FROM milestones WHERE id = ?`, m.id);
    expect(row?.status).toBe("done");
    await expect(complete_milestone(env.DB, m.id)).rejects.toThrow();   // already done
    await expect(complete_milestone(env.DB, 9999)).rejects.toThrow();   // missing
  });
});

describe("list_roadmap", () => {
  it("computes progress from a MOCKED GitHub response, orders by target_date, and stores nothing; all-closed does NOT auto-flip", async () => {
    // Two live milestones, the earlier-dated one second to prove ordering.
    const p1 = await stage_milestone_proposal(env.DB, { title: "Later", target_date: "2026-12-01", status: "upcoming", github_ref: [1], change_summary: "s", confidence: "high" }, "andres");
    const p2 = await stage_milestone_proposal(env.DB, { title: "Sooner", target_date: "2026-07-01", status: "in_progress", github_ref: [1, 2], change_summary: "s", confidence: "high" }, "andres");
    const mLater = await promote_milestone_proposal(env.DB, p1, "andres");
    const mSooner = await promote_milestone_proposal(env.DB, p2, "andres");

    // All linked issues closed.
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/2": { state: "closed" } });
    const roadmap = await list_roadmap(env.DB, { token: "t", repo: "o/r", fetchImpl });

    expect(roadmap.map((m) => m.title)).toEqual(["Sooner", "Later"]); // target_date ASC
    expect(roadmap.find((m) => m.title === "Sooner")!.progress).toEqual({ closed: 2, total: 2 });

    // 100% closed must NOT flip status — only the explicit complete route does that.
    expect(roadmap.find((m) => m.title === "Sooner")!.status).toBe("in_progress");
    const storedSooner = await first<MilestoneRow>(env.DB, `SELECT * FROM milestones WHERE id = ?`, mSooner.id);
    expect(storedSooner?.status).toBe("in_progress"); // nothing written by the read
    expect(storedSooner?.updated_at).toBe(mSooner.updated_at);
    void mLater;
  });

  it("returns milestones WITHOUT progress when no token is available (fallback seam)", async () => {
    const pid = await stage_milestone_proposal(env.DB, { title: "GA", target_date: "2026-09-01", status: "upcoming", github_ref: [1], change_summary: "s", confidence: "high" }, "andres");
    await promote_milestone_proposal(env.DB, pid, "andres");
    const roadmap = await list_roadmap(env.DB, { token: null, repo: "o/r" });
    expect(roadmap).toHaveLength(1);
    expect(roadmap[0].progress).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/roadmap.test.ts`
Expected: FAIL — `src/tools/roadmap.ts` and the new writers do not exist.

- [ ] **Step 3: Create `src/tools/roadmap.ts`**

```ts
import type { MilestoneRow } from "@shared/rows";
import { type DB, all } from "../db";

const GH_API = "application/vnd.github+json";
const USER_AGENT = "sapling-context";

/**
 * Live progress for a milestone's github_ref, computed from GitHub at read time.
 * `ref` is JSON: a number (a GitHub milestone) or an array of issue numbers.
 * Never throws — returns null on parse failure, a non-OK response (expired/revoked
 * token, missing resource), or any error, so /roadmap degrades gracefully.
 * `fetchImpl` is injectable for tests (the pool has no exported fetch mock).
 */
export async function fetchMilestoneProgress(opts: {
  token: string;
  repo: string;
  ref: string;
  fetchImpl?: typeof fetch;
}): Promise<{ closed: number; total: number } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, accept: GH_API, "user-agent": USER_AGENT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.ref);
  } catch {
    return null;
  }

  try {
    if (Array.isArray(parsed)) {
      let closed = 0;
      for (const n of parsed) {
        const res = await doFetch(`https://api.github.com/repos/${opts.repo}/issues/${n}`, { headers });
        if (!res.ok) return null;
        const data = (await res.json()) as { state?: string };
        if (data.state === "closed") closed++;
      }
      return { closed, total: parsed.length };
    }
    if (typeof parsed === "number") {
      const res = await doFetch(`https://api.github.com/repos/${opts.repo}/milestones/${parsed}`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { open_issues?: number; closed_issues?: number };
      const closed = data.closed_issues ?? 0;
      return { closed, total: (data.open_issues ?? 0) + closed };
    }
    return null;
  } catch {
    return null;
  }
}

export type MilestoneWithProgress = MilestoneRow & {
  progress: { closed: number; total: number } | null;
};

/**
 * Read the roadmap: live milestones in target-date order, each merged with live
 * GitHub progress. Stores nothing. With no token or no repo, progress is null for all
 * (clean fallback seam); a per-milestone GitHub failure yields null for that one only.
 */
export async function list_roadmap(
  db: DB,
  opts: { token?: string | null; repo?: string; fetchImpl?: typeof fetch } = {}
): Promise<MilestoneWithProgress[]> {
  const milestones = await all<MilestoneRow>(
    db,
    `SELECT * FROM milestones ORDER BY target_date ASC, id ASC`
  );
  if (!opts.token || !opts.repo) {
    return milestones.map((m) => ({ ...m, progress: null }));
  }
  const out: MilestoneWithProgress[] = [];
  for (const m of milestones) {
    const progress = m.github_ref
      ? await fetchMilestoneProgress({ token: opts.token, repo: opts.repo, ref: m.github_ref, fetchImpl: opts.fetchImpl })
      : null;
    out.push({ ...m, progress });
  }
  return out;
}
```

- [ ] **Step 4: Add the promote/complete writers**

Add `MilestoneRow`, `MilestoneProposalRow` to the row-types import at the top of `src/tools/writes.ts`:
```ts
import type { DocRow, DocVersionRow, AdrRow, MilestoneRow, MilestoneProposalRow } from "@shared/rows";
```
Append:
```ts
/** Human confirmation: turn a staged milestone proposal into a live roadmap milestone. */
export async function promote_milestone_proposal(db: DB, id: number, author: string): Promise<MilestoneRow> {
  const p = await first<MilestoneProposalRow>(db, `SELECT * FROM milestone_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`no such milestone proposal: ${id}`);
  if (p.staged_status === "promoted") throw new Error(`milestone proposal already promoted: ${id}`);

  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO milestones (title, description, target_date, status, github_ref, created_at, created_by, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    p.title,
    p.target_date,
    p.status,        // gate guaranteed this is never 'done'
    p.github_ref,
    now,
    author,
    now
  );
  await run(db, `UPDATE milestone_proposals SET staged_status = 'promoted' WHERE id = ?`, id);
  const milestoneId = res.meta.last_row_id as number;
  return (await first<MilestoneRow>(db, `SELECT * FROM milestones WHERE id = ?`, milestoneId))!;
}

/** Human confirmation: flip a live milestone to 'done'. Rejects if missing or already done. */
export async function complete_milestone(db: DB, id: number): Promise<MilestoneRow> {
  const m = await first<MilestoneRow>(db, `SELECT * FROM milestones WHERE id = ?`, id);
  if (!m) throw new Error(`no such milestone: ${id}`);
  if (m.status === "done") throw new Error(`milestone already done: ${id}`);
  const updated_at = nowIso();
  await run(db, `UPDATE milestones SET status = 'done', updated_at = ? WHERE id = ?`, updated_at, id);
  return { ...m, status: "done", updated_at };
}
```

- [ ] **Step 5: Run the file + full suite + typecheck**

Run: `npx vitest run test/roadmap.test.ts`
Expected: PASS (all roadmap cases).

Run: `npx vitest run`
Expected: `Tests  56 passed (56)`.

Run: `npm run typecheck`
Expected: no errors.

### Task 8: Wire the routes (`GET /roadmap`, promote, complete) + MCP surfaces (`propose_milestone`, `get_roadmap`) + `GITHUB_REPO` binding

**Files:**
- Modify: `src/env.ts`, `test/env.d.ts`, `wrangler.toml` (`GITHUB_REPO`)
- Modify: `src/routes.ts` (3 routes)
- Modify: `src/mcp.ts` (`propose_milestone` write tool, `get_roadmap` read tool)
- Test: `test/roadmap.test.ts` (append route-wiring + gate-on-MCP cases)

**Interfaces:**
- Consumes: `list_roadmap` (Task 7), `promote_milestone_proposal`, `complete_milestone` (Task 7), `getStoredToken` (Task 5), `ingestMilestoneProposal` (Task 6).
- Produces: `Env.GITHUB_REPO?: string`; HTTP `GET /roadmap`, `POST /milestone-proposals/:id/promote`, `POST /milestones/:id/complete` (all session-gated); MCP tools `propose_milestone` (write, through the gate) and `get_roadmap` (read).

- [ ] **Step 1: Write the failing test (append to `test/roadmap.test.ts`)**

```ts
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";

async function cookieFor(login: string): Promise<string> {
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("roadmap HTTP routes (session-gated)", () => {
  it("GET /roadmap returns milestones (no token in test env → progress null) and 401 without a session", async () => {
    const pid = await stage_milestone_proposal(env.DB, { title: "GA", target_date: "2026-09-01", status: "upcoming", github_ref: [1], change_summary: "s", confidence: "high" }, "andres");
    await promote_milestone_proposal(env.DB, pid, "andres");

    const unauth = await app.request("/roadmap", {}, env);
    expect(unauth.status).toBe(401);

    const res = await app.request("/roadmap", { headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { milestones: { title: string; progress: unknown }[] };
    expect(body.milestones).toHaveLength(1);
    expect(body.milestones[0].progress).toBeNull(); // no stored github_token for this user → fallback
  });

  it("POST /milestones/:id/complete flips status for an authenticated principal", async () => {
    const pid = await stage_milestone_proposal(env.DB, { title: "GA", target_date: "2026-09-01", status: "in_progress", change_summary: "s", confidence: "high" }, "andres");
    const m = await promote_milestone_proposal(env.DB, pid, "andres");
    const res = await app.request(`/milestones/${m.id}/complete`, { method: "POST", headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    const row = await first<MilestoneRow>(env.DB, `SELECT * FROM milestones WHERE id = ?`, m.id);
    expect(row?.status).toBe("done");
  });

  it("POST /milestone-proposals/:id/promote materializes a live milestone", async () => {
    const pid = await stage_milestone_proposal(env.DB, { title: "GA", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "high" }, "andres");
    const res = await app.request(`/milestone-proposals/${pid}/promote`, { method: "POST", headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    expect(await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/roadmap.test.ts`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Add the `GITHUB_REPO` binding**

In `src/env.ts`, add to `Env`:
```ts
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → milestones without progress
```
In `test/env.d.ts`, add to the `Cloudflare.Env` interface:
```ts
      GITHUB_REPO?: string;
```
In `wrangler.toml`, add a vars block (production config; the example repo can be edited at deploy):
```toml
[vars]
GITHUB_REPO = "SaplingLearn/context"
```
(Note: tests never make a real GitHub call — `getStoredToken` returns null for test users, so `list_roadmap` short-circuits to the no-progress path before any fetch, regardless of `GITHUB_REPO`.)

- [ ] **Step 4: Add the three HTTP routes**

In `src/routes.ts`, add imports:
```ts
import { promote_doc, ratify_adr, promote_milestone_proposal, complete_milestone } from "./tools/writes";
import { list_roadmap } from "./tools/roadmap";
import { getStoredToken } from "./auth/github";
```
(Merge the `./tools/writes` import with the one added in STEP 2.)

Append:
```ts
// Roadmap read (session-gated): milestones in target-date order with live GitHub progress.
app.get("/roadmap", async (c) => {
  const token = await getStoredToken(c.env.DB, c.get("principal").login, c.env.COOKIE_SECRET);
  const milestones = await list_roadmap(c.env.DB, { token, repo: c.env.GITHUB_REPO });
  return c.json({ milestones });
});

// Human confirmation (session-gated): promote a staged milestone proposal into a live milestone.
app.post("/milestone-proposals/:id/promote", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const milestone = await promote_milestone_proposal(c.env.DB, id, c.get("principal").login);
    return c.json({ ok: true, milestone });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human confirmation (session-gated): flip a live milestone to 'done'.
app.post("/milestones/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const milestone = await complete_milestone(c.env.DB, id);
    return c.json({ ok: true, milestone });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
```

- [ ] **Step 5: Add the MCP `propose_milestone` (write) + `get_roadmap` (read) tools**

In `src/mcp.ts`, extend imports:
```ts
import { ingestFeedEntry, ingestDocProposal, ingestMilestoneProposal } from "./consumer";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";
import { list_roadmap } from "./tools/roadmap";
import { getStoredToken } from "./auth/github";
```
Add a read tool (alongside the other read tools):
```ts
  server.tool("get_roadmap", "Read the roadmap: milestones in target-date order with live GitHub progress.", {}, async () =>
    runTool(async () => {
      const token = await getStoredToken(env.DB, principal.login, env.COOKIE_SECRET);
      return list_roadmap(env.DB, { token, repo: env.GITHUB_REPO });
    })
  );
```
Add the write tool (alongside `append_feed` / `propose_doc_update`), funnelling through the gate:
```ts
  server.tool(
    "propose_milestone",
    "Propose a roadmap milestone (create/update) through the gate; staged for human promotion. A 'done' status or low confidence routes to needs_triage.",
    {
      title: z.string(),
      target_date: z.string(),
      status: z.enum(["upcoming", "in_progress", "done"]),
      github_ref: z.union([z.number(), z.array(z.number())]).optional(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
    },
    async (proposal) => runTool(() => ingestMilestoneProposal(env.DB, proposal, principal.login))
  );
```
(Note: no MCP tool for promote or complete — those stay human HTTP routes.)

- [ ] **Step 6: Run the file + full suite + typecheck**

Run: `npx vitest run test/roadmap.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: `Tests  59 passed (59)`.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit STEP 3**

```bash
git add migrations/0004_roadmap.sql src/tools/roadmap.ts shared/contract.ts shared/rows.ts \
  src/consumer.ts src/tools/writes.ts src/routes.ts src/mcp.ts \
  src/auth/crypto.ts src/auth/github.ts src/auth/routes.ts \
  src/env.ts test/env.d.ts wrangler.toml test/apply-migrations.ts test/roadmap.test.ts
git commit -m "$(cat <<'EOF'
feat(roadmap): milestone layer with gated proposals, human promote/complete, live GitHub progress

- milestones + milestone_proposals tables (new migration); progress computed live, never stored
- ingestMilestoneProposal gate fn; /ingest and MCP propose_milestone funnel through it ('done'/low-conf → triage)
- human-only HTTP routes: promote proposal→live, complete live→'done' (never MCP, never auto-flip)
- GET /roadmap + MCP get_roadmap merge live progress from GITHUB_REPO using the principal's
  retained, AES-GCM-sealed OAuth token; null/expired token → graceful no-progress fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] Run full suite: `npx vitest run` → expect **59 passed** (31 baseline + 2 STEP 1 + 9 STEP 2 + 17 STEP 3). Exact STEP-3 count may differ slightly with case splits; the invariant is **all green, ≥ 31, none regressed**.
- [ ] Run `npm run typecheck` → no errors.
- [ ] Confirm the gate holds on every write path: `/ingest` (feed/doc/adr/milestone), MCP `append_feed`, `propose_doc_update`, `propose_milestone` all route through `src/consumer.ts` gate functions; promote/ratify/complete are human HTTP routes only.
- [ ] Confirm no deferred seam was activated (no Queue/Vectorize/MCP-OAuth/webhook code).
- [ ] `git log --oneline -4` shows one commit per STEP plus the Task 0 reconcile checkpoint.

## Self-Review (performed against the spec)

- **STEP 1** — `issues: number[]` added to `artifacts` (default `[]`); consumer/gate stores artifacts as-is (no new tables/sync/webhook); MCP `append_feed` passes `issues` through; round-trip test present. ✓
- **STEP 2** — `promote_doc(slug, version)` flips status, copies body, bumps `current_version`, sets `updated_*`, non-destructive, rejects unstaged/missing; `ratify_adr(id)` flips draft→ratified, rejects missing/already; both authenticated HTTP routes, neither an MCP tool; tests cover flip + prior-versions-intact + reject. ✓
- **STEP 3** — `milestones` table with exact columns + 3-status enum; `github_ref` = milestone number or issue-number array; no progress stored; progress computed live and merged; `milestone_proposals` in contract routed through the SAME gate via `ingestMilestoneProposal` from both `/ingest` and MCP `propose_milestone`; staged, not live until promoted; terminal `'done'` only via `complete_milestone` HTTP route, never MCP, never auto-flipped; `GET /roadmap` (session-gated, target-date order, live progress) + MCP `get_roadmap`; token fallback seam clean. Tests: gate-stages-not-live, complete-flips + no-auto-flip-on-all-closed, progress-from-mocked-GitHub-stores-nothing. ✓
- **Token seam** — org OAuth token retained AES-GCM-sealed under `COOKIE_SECRET` at callback; no new auth flow; expired/revoked/null → graceful no-progress. ✓
- **Placeholder scan** — every code/test step contains complete, runnable code; no TBD/TODO. ✓
- **Type consistency** — `MilestoneRow`/`MilestoneProposalRow`/`MilestoneProposal`/`MilestoneIngestResult`/`MilestoneWithProgress` and the writer/read signatures are used identically across Tasks 4–8. ✓
