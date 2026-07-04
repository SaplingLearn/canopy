# Canopy Frontend Wire-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the componentized mock triage frontend (Review + Maintenance) to the real backend reads and writes, then delete the mock module.

**Architecture:** Components in `web/src/review.ts` / `web/src/maintenance.ts` stay purely presentational. A new mapping layer (`web/src/triage-map.ts`) turns backend read shapes into the props the components already expect. Loaders, `Loadable` state slices, and write dispatch live in `web/src/main.ts` + `web/src/render.ts` (the existing screen/dispatch layer). `web/src/api.ts` gains the two missing identity helpers. The wire contract is fully documented in `docs/superpowers/plans/2026-07-04-wire-contract-audit-results.md`.

**Tech Stack:** TypeScript, Vite SPA (`web/`), Vitest (pure render tests in `test/`, no DOM), Hono Worker backend (already finished — this plan does NOT touch `src/` or `shared/`).

## Global Constraints

- Components stay presentational: NO fetching, NO state in `web/src/review.ts`, `web/src/maintenance.ts`, `web/src/ui.ts`. Fetching lives in `main.ts`; shape mapping lives in `web/src/triage-map.ts` ONLY.
- Every read is cookie-gated + same-origin; `api.ts`'s `getJson`/`postJson` already send `credentials: "same-origin"` — reuse them, never call `fetch` directly.
- Reuse the existing patterns verbatim: `Loadable<T>` (`render.ts:24-28`), `notice()` (`render.ts:208`), `Unauthorized` → `state.view = "auth"; state.authStep = "login"` redirect, `flash()` (`main.ts:201`), `ApiError.message` in flashes.
- After any verdict (promote/reject/ratify/discard/assign/map): REFETCH the affected list. Never locally decrement counts.
- Load all four triage lists at session boot so sidebar badges are correct on every screen.
- Assignable doc sections are `reference` / `context` / `decisions` ONLY — exclude `needs-triage` from `SECTIONS` (`shared/vocabulary.ts:3`). Spaces: `sapling` / `canopy`. Feed tags: `TAGS` (`shared/vocabulary.ts:4`).
- Do NOT render the milestone-proposals queue anywhere (Phase-2 teardown parks it). `api.ts` keeps its helpers; the triage UI must not reference them.
- ADR third section label is **"Rationale"** everywhere (matches the backend field and the MCP query engine).
- Session ids ("session 4f2c") are mock fiction — dropped everywhere, never stored.
- `low_confidence === 1` proposals render a small "FLAGGED" marker (the gate's scrutinize signal). `change_kind` and `confidence` are ignored for now.
- Identity map: NO auto-selected person; a two-step confirm states the concrete effect before posting. Keep the map code path localized (it will be reshaped to acknowledge/dismiss later).
- At the end: `web/src/triage-mock.ts` is deleted and nothing imports it; the `reviewDone`/`unplacedDone`/`identityDone` mock-state arrays are gone.
- Verification commands: `npx vitest run test/<file>.test.ts` (one file), `npm test` (all), `npm run typecheck` (NOT part of `npm test` — always run both), `npm run build:web` (final).

---

### Task 1: Extract shared helpers into importable modules

The mapping layer needs `collapsedLineDiff` (currently private-ish in `render.ts`) and `relTime`/`initialsOf` (currently module-private in `render.ts`). Importing `render.ts` from `triage-map.ts` would be circular (`render.ts` will import the mapping fns). Move the diff helpers to a new `web/src/diff.ts` and the two string helpers into `web/src/ui.ts` (dependency-free atoms module). Pure move — existing tests must stay green.

**Files:**
- Create: `web/src/diff.ts`
- Modify: `web/src/render.ts` (remove moved code at lines 553-600 and 158-177; extend the `./ui` import)
- Modify: `web/src/ui.ts` (add `initialsOf`, `relTime`)
- Modify: `test/render.review.test.ts:15` (import path)

**Interfaces:**
- Consumes: nothing new.
- Produces: `web/src/diff.ts` exports `type DiffKind = "ctx" | "add" | "del" | "ellipsis"`, `type DiffRow = { t: DiffKind; text: string }`, `lineDiff(oldText: string, newText: string): DiffRow[]`, `collapsedLineDiff(oldText: string, newText: string, ctx?: number): DiffRow[]`. `web/src/ui.ts` additionally exports `initialsOf(login: string): string` and `relTime(iso: string | null): string`.

- [ ] **Step 1: Create `web/src/diff.ts`**

Move lines 553-600 of `web/src/render.ts` (the `DiffKind`, `DiffRow`, `lineDiff`, `collapsedLineDiff` block, including their doc comments) verbatim into a new file with this header:

```typescript
// Line-diff helpers for the Review surface: an LCS line diff plus a collapsed
// variant that folds large unchanged runs into "N unchanged lines" ellipsis
// rows. Pure functions — no DOM, no state; test/render.review.test.ts covers
// them directly.

export type DiffKind = "ctx" | "add" | "del" | "ellipsis";

export type DiffRow = { t: DiffKind; text: string };
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n"), b = newText.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: a[i] }); i++; }
    else { out.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

/**
 * Line diff with large unchanged runs collapsed to "N unchanged lines" ellipsis markers.
 * ctx = how many context lines to show around each changed hunk (default 3).
 */
export function collapsedLineDiff(oldText: string, newText: string, ctx = 3): DiffRow[] {
  const rows = lineDiff(oldText, newText);
  if (rows.length === 0) return [];
  const changed = new Set<number>();
  rows.forEach((r, i) => { if (r.t !== "ctx") changed.add(i); });
  if (changed.size === 0) return rows; // nothing changed — return as-is (or callers can skip)
  const visible = new Set<number>();
  changed.forEach((idx) => {
    for (let j = Math.max(0, idx - ctx); j <= Math.min(rows.length - 1, idx + ctx); j++) visible.add(j);
  });
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (visible.has(i)) { out.push(rows[i]); i++; }
    else {
      let j = i;
      while (j < rows.length && !visible.has(j)) j++;
      out.push({ t: "ellipsis", text: `${j - i} unchanged line${j - i !== 1 ? "s" : ""}` });
      i = j;
    }
  }
  return out;
}
```

(This is the exact code at `render.ts:556-600` — a verbatim move, shown here so the task is self-contained.)

Delete the moved block from `render.ts` (nothing inside `render.ts` uses these functions — they were exported for the wire-up).

- [ ] **Step 2: Move `initialsOf` and `relTime` into `web/src/ui.ts`**

Cut `initialsOf` (`render.ts:159-163`) and `relTime` (`render.ts:164-177`) with their doc comments, paste them at the end of `web/src/ui.ts`, and add `export` to both:

```typescript
/** Two-letter avatar initials from a github login, e.g. "jose-a" → "JO". */
export function initialsOf(login: string): string {
  const letters = login.replace(/[^a-zA-Z]/g, "");
  return (letters.slice(0, 2) || login.slice(0, 2) || "?").toUpperCase();
}
/** Relative time from an ISO timestamp, e.g. "32m ago" / "2d ago". */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
```

In `render.ts`, change the ui import (line 14) to:

```typescript
import { esc, attr, initialsOf, relTime } from "./ui";
```

- [ ] **Step 3: Update the test import**

In `test/render.review.test.ts` line 15, change:

```typescript
import { lineDiff, collapsedLineDiff } from "../web/src/render";
```

to:

```typescript
import { lineDiff, collapsedLineDiff } from "../web/src/diff";
```

- [ ] **Step 4: Verify tests and types**

Run: `npx vitest run test/render.review.test.ts`
Expected: PASS (all existing lineDiff/collapsedLineDiff/review/maintenance tests green).

Run: `npm run typecheck`
Expected: clean exit, no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/diff.ts web/src/render.ts web/src/ui.ts test/render.review.test.ts
git commit -m "refactor(web): extract diff + time/initials helpers into importable modules"
```

---

### Task 2: Add the two missing identity helpers to `api.ts`

`GET /identity-tasks` (envelope `{tasks}`) and `POST /identity-tasks/:login/map {person}` have no client helpers (audit §7). Add the types + helpers following the file's existing idiom. No unit test — `api.ts` helpers have no fetch-mock harness (existing convention); the typecheck plus the wiring tasks cover them.

**Files:**
- Modify: `web/src/api.ts` (add after `listStagedProposals`, around line 171)

**Interfaces:**
- Consumes: `getJson` / `postJson` (existing, `api.ts:21-42`).
- Produces:
  - `interface IdentitySample { semantic_key: string; event_type: string; ref_number: number; title: string | null; occurred_at: string | null }`
  - `interface IdentityTask { login: string; first_seen: string; status: "pending" | "resolved"; resolved_at: string | null; resolved_by: string | null; sample: IdentitySample[] }`
  - `listIdentityTasks(): Promise<IdentityTask[]>`
  - `mapIdentity(login: string, person: string): Promise<{ ok: true; login: string; person: string; status: "resolved" }>`

- [ ] **Step 1: Add the read type + helper**

After the `listStagedProposals` block (`api.ts:169-171`), add:

```typescript
// Maintenance · Identity: pending unknown-login tasks, each with a small LIVE
// activity sample. Mirrors src/tools/reads.ts IdentityTaskWithSample exactly
// (web/ can't import src/, so it's re-declared here atop @shared/rows's
// IdentityTaskRow shape). Envelope: { tasks }.
export interface IdentitySample {
  semantic_key: string;
  event_type: string;      // 'pr_merged' | 'pr_closed' | 'issue'
  ref_number: number;
  title: string | null;    // null when the event's raw snapshot is malformed
  occurred_at: string | null;
}
export interface IdentityTask {
  login: string;
  first_seen: string;
  status: "pending" | "resolved";
  resolved_at: string | null;
  resolved_by: string | null;
  sample: IdentitySample[];
}
export function listIdentityTasks(): Promise<IdentityTask[]> {
  return getJson<{ tasks: IdentityTask[] }>("/identity-tasks").then((r) => r.tasks);
}
```

- [ ] **Step 2: Add the map write helper**

In the "triage write-back" section (after `assignTriage`, `api.ts:201-203`), add:

```typescript
// Maintenance · Identity: map a login to a person — the `people` table's only
// runtime write. `person` is a free non-empty string; the picker posts a
// teammate's GitHub login as that value.
export function mapIdentity(login: string, person: string): Promise<{ ok: true; login: string; person: string; status: "resolved" }> {
  return postJson(`/identity-tasks/${encodeURIComponent(login)}/map`, { person });
}
```

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): add listIdentityTasks + mapIdentity api helpers"
```

---

### Task 3: Mapping layer — Review (proposals + decisions)

Create `web/src/triage-map.ts`: pure functions turning `StagedProposal` / `AdrRow` reads into `ReviewItem` props, the synthesized-id codec the write buttons decode, and the body-diff adapter. TDD in a new `test/triage-map.test.ts` (pure vitest, same pool as `test/render.review.test.ts`).

Note: this task references `DiffEntry` with an `"ellipsis"` kind — `review.ts` gains the rendering for it in Task 4, but the one-word type widening happens HERE (see Step 3) so this task typechecks on its own.

**Files:**
- Create: `web/src/triage-map.ts`
- Create: `test/triage-map.test.ts`

**Interfaces:**
- Consumes: `StagedProposal`, `AdrRow` (from `./api`), `collapsedLineDiff` (from `./diff`), `initialsOf`, `relTime` (from `./ui`), `ReviewItem` (from `./review`).
- Produces (exact signatures later tasks rely on):
  - `proposalReviewItem(p: StagedProposal): ReviewItem`
  - `adrReviewItem(a: AdrRow): ReviewItem`
  - `reviewItemsFromReads(proposals: StagedProposal[], adrs: AdrRow[]): ReviewItem[]` — merged, newest-first by `created_at`
  - `type ReviewRef = { kind: "doc"; slug: string; version: number } | { kind: "adr"; id: number }`
  - `decodeReviewId(id: string): ReviewRef | null`
  - `diffEntries(promotedBody: string, stagedBody: string): { t: "ctx" | "add" | "del" | "ellipsis"; s: string }[]`
  - This task ALSO adds two one-line changes to `web/src/review.ts` so it is self-contained: the optional prop `flagged?: boolean` on `ReviewItem` (line 39) and the `"ellipsis"` member on `DiffEntryKind` (line 18). Rendering for both is Task 4.

- [ ] **Step 1: Write the failing tests**

Create `test/triage-map.test.ts`:

```typescript
/**
 * Mapping-layer tests — backend read shapes → the props the presentational
 * triage components expect (web/src/triage-map.ts). Pure functions, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
  proposalReviewItem, adrReviewItem, reviewItemsFromReads, decodeReviewId, diffEntries,
} from "../web/src/triage-map";
import type { StagedProposal, AdrRow } from "../web/src/api";

function makeProposal(overrides: Partial<StagedProposal> = {}): StagedProposal {
  return {
    slug: "deploy-runbook", version: 7, title: "Deployment Runbook",
    section: "reference", space: "sapling", summary: "Rollback rewritten.",
    author: "octo-agent", confidence: "high", status: "staged",
    change_kind: "edit", low_confidence: 0, base_version: 6, current_version: 6,
    created_at: "2026-07-01T10:00:00Z",
    stagedBody: "line one\nline two", promotedBody: "line one\nold line two",
    ...overrides,
  };
}

function makeAdr(overrides: Partial<AdrRow> = {}): AdrRow {
  return {
    id: 14, title: "Adopt outbox pattern",
    context: "Events diverge silently.",
    decision: "Write events to an outbox table. A relay publishes them.",
    rationale: "One hop of latency is acceptable.",
    status: "draft", confidence: "high",
    created_at: "2026-07-02T10:00:00Z", created_by: "octo-agent", content_hash: null,
    ...overrides,
  };
}

describe("proposalReviewItem", () => {
  it("synthesizes the doc id and decodeReviewId round-trips it", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.id).toBe("doc:deploy-runbook@7");
    expect(decodeReviewId(item.id)).toEqual({ kind: "doc", slug: "deploy-runbook", version: 7 });
  });

  it("derives the eyebrow from real space/section and fixes kind/badge", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.kind).toBe("proposal");
    expect(item.eyebrow).toBe("PROPOSAL · SAPLING / REFERENCE");
    expect(item.badge).toBe("STAGED");
    expect(item.liveVersion).toBe("LIVE (v6)");
  });

  it("derives agent fields from the author (no session id) and time from created_at", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.agent).toBe("octo-agent");
    expect(item.agentInitials).toBe("OC");
    expect(item.agent).not.toContain("session");
  });

  it("marks stale only when base_version < current_version, with a note naming both", () => {
    const stale = proposalReviewItem(makeProposal({ base_version: 5, current_version: 6 }));
    expect(stale.stale).toBe(true);
    expect(stale.staleNote).toContain("v5");
    expect(stale.staleNote).toContain("v6");
    expect(proposalReviewItem(makeProposal({ base_version: 6, current_version: 6 })).stale).toBe(false);
    expect(proposalReviewItem(makeProposal({ base_version: null })).stale).toBe(false);
  });

  it("falls back to a staged-body excerpt when summary is null", () => {
    const item = proposalReviewItem(makeProposal({ summary: null, stagedBody: "\n\nFirst real line.\nmore" }));
    expect(item.summary).toBe("First real line.");
  });

  it("flags low_confidence proposals", () => {
    expect(proposalReviewItem(makeProposal({ low_confidence: 1 })).flagged).toBe(true);
    expect(proposalReviewItem(makeProposal()).flagged).toBe(false);
  });

  it("computes the diff from the two raw bodies", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.diff!.some((e) => e.t === "del" && e.s === "old line two")).toBe(true);
    expect(item.diff!.some((e) => e.t === "add" && e.s === "line two")).toBe(true);
  });
});

describe("diffEntries — real-size bodies", () => {
  it("collapses a multi-hundred-line body to hunks + ellipsis rows", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const oldBody = lines.join("\n");
    const newLines = [...lines];
    newLines[50] = "changed A";
    newLines[200] = "changed B";
    const rows = diffEntries(oldBody, newLines.join("\n"));
    expect(rows.length).toBeLessThan(50);
    const ellipses = rows.filter((r) => r.t === "ellipsis");
    expect(ellipses.length).toBeGreaterThanOrEqual(2);
    expect(ellipses[0].s).toMatch(/\d+ unchanged lines/);
  });
});

describe("adrReviewItem", () => {
  it("synthesizes the adr id and decodeReviewId round-trips it", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.id).toBe("adr:14");
    expect(decodeReviewId(item.id)).toEqual({ kind: "adr", id: 14 });
  });

  it("formats the eyebrow from the numeric id and fixes kind/badge", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.kind).toBe("decision");
    expect(item.eyebrow).toBe("DECISION · ADR-014");
    expect(item.badge).toBe("DRAFT");
  });

  it("builds Context / Decision / Rationale sections, skipping nulls", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.adr!.map((s) => s.h)).toEqual(["Context", "Decision", "Rationale"]);
    const noRationale = adrReviewItem(makeAdr({ rationale: null }));
    expect(noRationale.adr!.map((s) => s.h)).toEqual(["Context", "Decision"]);
  });

  it("derives the card summary from the first sentence of decision", () => {
    expect(adrReviewItem(makeAdr()).summary).toBe("Write events to an outbox table.");
    expect(adrReviewItem(makeAdr({ decision: null })).summary).toBe("");
  });
});

describe("reviewItemsFromReads", () => {
  it("merges the two reads newest-first by created_at", () => {
    const items = reviewItemsFromReads(
      [makeProposal({ created_at: "2026-07-01T10:00:00Z" })],
      [makeAdr({ created_at: "2026-07-02T10:00:00Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["adr:14", "doc:deploy-runbook@7"]);
  });
});

describe("decodeReviewId — invalid inputs", () => {
  it("returns null for unknown prefixes and malformed ids", () => {
    expect(decodeReviewId("p1")).toBeNull();
    expect(decodeReviewId("doc:no-version")).toBeNull();
    expect(decodeReviewId("doc:slug@abc")).toBeNull();
    expect(decodeReviewId("adr:abc")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/triage-map.test.ts`
Expected: FAIL — `Cannot find module '../web/src/triage-map'`.

- [ ] **Step 3: Implement the Review half of `web/src/triage-map.ts`**

First add the one-line prop to `web/src/review.ts` — inside `interface ReviewItem` (after `time: string;`, line 33):

```typescript
  /** Gate's scrutinize signal: staged with low_confidence = 1. Rendered as a small marker. */
  flagged?: boolean;
```

Then create `web/src/triage-map.ts`:

```typescript
// The triage mapping layer: turns backend read shapes (api.ts) into the props
// the presentational Review/Maintenance components already expect. This is the
// reshape deferred during componentization — it lives HERE, in one place per
// surface, never inside components. Pure functions, no fetching, no state.

import type { StagedProposal, AdrRow } from "./api";
import type { ReviewItem } from "./review";
import { collapsedLineDiff } from "./diff";
import { initialsOf, relTime } from "./ui";

// ── shared derivations ───────────────────────────────────────────────────────
/** First non-empty line of a body — the card-summary fallback. */
function excerpt(body: string): string {
  return body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** First sentence of a text (up to . ! or ?), for the ADR card summary. */
function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

// ── Review · Proposals ───────────────────────────────────────────────────────
/** Client-side diff of the two raw bodies the read carries (backend sends no diff). */
export function diffEntries(promotedBody: string, stagedBody: string): { t: "ctx" | "add" | "del" | "ellipsis"; s: string }[] {
  return collapsedLineDiff(promotedBody, stagedBody).map((r) => ({ t: r.t, s: r.text }));
}

export function proposalReviewItem(p: StagedProposal): ReviewItem {
  const stale = p.base_version !== null && p.base_version < p.current_version;
  return {
    id: `doc:${p.slug}@${p.version}`,
    kind: "proposal",
    eyebrow: `PROPOSAL · ${p.space.toUpperCase()} / ${p.section.toUpperCase()}`,
    badge: "STAGED",
    badgeColor: "var(--amber)",
    title: p.title,
    summary: p.summary ?? excerpt(p.stagedBody),
    agent: p.author,
    agentInitials: initialsOf(p.author),
    time: relTime(p.created_at),
    flagged: p.low_confidence === 1,
    stale,
    staleNote: stale
      ? `Proposed from v${p.base_version} — the live doc is now v${p.current_version}. Review against current content before promoting.`
      : undefined,
    liveVersion: `LIVE (v${p.current_version})`,
    diff: diffEntries(p.promotedBody, p.stagedBody),
  };
}

// ── Review · Decisions ───────────────────────────────────────────────────────
export function adrReviewItem(a: AdrRow): ReviewItem {
  const sections = [
    { h: "Context", p: a.context },
    { h: "Decision", p: a.decision },
    { h: "Rationale", p: a.rationale },
  ].filter((s): s is { h: string; p: string } => s.p !== null && s.p.trim() !== "");
  return {
    id: `adr:${a.id}`,
    kind: "decision",
    eyebrow: `DECISION · ADR-${String(a.id).padStart(3, "0")}`,
    badge: "DRAFT",
    badgeColor: "var(--blue)",
    title: a.title,
    summary: a.decision ? firstSentence(a.decision) : "",
    agent: a.created_by,
    agentInitials: initialsOf(a.created_by),
    time: relTime(a.created_at),
    adr: sections,
  };
}

/** The Review queue: both reads merged, newest first (ISO strings compare lexically). */
export function reviewItemsFromReads(proposals: StagedProposal[], adrs: AdrRow[]): ReviewItem[] {
  const merged = [
    ...proposals.map((p) => ({ at: p.created_at, item: proposalReviewItem(p) })),
    ...adrs.map((a) => ({ at: a.created_at, item: adrReviewItem(a) })),
  ];
  merged.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return merged.map((m) => m.item);
}

// ── synthesized-id codec (write buttons decode back to route params) ─────────
export type ReviewRef = { kind: "doc"; slug: string; version: number } | { kind: "adr"; id: number };

export function decodeReviewId(id: string): ReviewRef | null {
  if (id.startsWith("doc:")) {
    const at = id.lastIndexOf("@");
    if (at < 4) return null;
    const version = Number(id.slice(at + 1));
    if (!Number.isInteger(version)) return null;
    return { kind: "doc", slug: id.slice(4, at), version };
  }
  if (id.startsWith("adr:")) {
    const n = Number(id.slice(4));
    return Number.isInteger(n) && id.length > 4 ? { kind: "adr", id: n } : null;
  }
  return null;
}
```

Note on `diff: diffEntries(...)`: without the `DiffEntryKind` widening, TypeScript rejects `"ellipsis"` against `DiffEntry`. Make the widening NOW (one word; Task 4 adds the rendering and tests): in `web/src/review.ts:18` change

```typescript
export type DiffEntryKind = "ctx" | "add" | "del" | "gap" | "h";
```

to

```typescript
export type DiffEntryKind = "ctx" | "add" | "del" | "gap" | "h" | "ellipsis";
```

(Task 4 adds the rendering for it; an unrendered kind falls through to the default ctx style until then, which is acceptable mid-branch.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/triage-map.test.ts`
Expected: PASS (all describes above).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/triage-map.ts web/src/review.ts test/triage-map.test.ts
git commit -m "feat(web): review mapping layer — backend reads to ReviewItem props"
```

---

### Task 4: Review components — render ellipsis diff rows + the FLAGGED marker

The real differ emits `ellipsis` rows ("N unchanged lines") that the viewer must render in all three modes, and `low_confidence` proposals need a small marker. TDD in the existing `test/render.review.test.ts`.

**Files:**
- Modify: `web/src/review.ts`
- Modify: `test/render.review.test.ts`

**Interfaces:**
- Consumes: `DiffEntry` now includes kind `"ellipsis"` (`DiffEntryKind` widened in Task 3's note — if not yet done, do it now: `export type DiffEntryKind = "ctx" | "add" | "del" | "gap" | "h" | "ellipsis"` at `review.ts:18`); `ReviewItem.flagged?: boolean` (added in Task 3).
- Produces: `unifiedDiff` / `splitDiffRows` / `splitDiff` / `renderedPreview` handle `"ellipsis"`; `reviewCard` and `reviewDetail` render a FLAGGED marker when `it.flagged`.

- [ ] **Step 1: Write the failing tests**

In `test/render.review.test.ts`, extend the review import (line 16) with `renderedPreview`:

```typescript
import { reviewView, unifiedDiff, renderedPreview, splitDiffRows, type ReviewItem, type ReviewProps } from "../web/src/review";
```

Add after the existing `splitDiffRows` describe:

```typescript
describe("diff viewer — ellipsis rows (collapsed unchanged runs)", () => {
  it("unifiedDiff renders an ellipsis row as a muted marker", () => {
    const html = unifiedDiff([{ t: "add", s: "new" }, { t: "ellipsis", s: "12 unchanged lines" }]);
    expect(html).toContain("12 unchanged lines");
  });

  it("splitDiffRows spans an ellipsis across both columns", () => {
    const rows = splitDiffRows([{ t: "ellipsis", s: "5 unchanged lines" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].left.text).toBe("5 unchanged lines");
    expect(rows[0].right.text).toBe("5 unchanged lines");
  });

  it("renderedPreview omits ellipsis rows", () => {
    const html = renderedPreview([{ t: "add", s: "kept" }, { t: "ellipsis", s: "9 unchanged lines" }]);
    expect(html).toContain("kept");
    expect(html).not.toContain("9 unchanged lines");
  });
});

describe("reviewView — flagged marker (low-confidence scrutiny signal)", () => {
  it("renders FLAGGED only for flagged items", () => {
    expect(reviewView(makeReviewProps({ items: [makeItem({ flagged: true })] }))).toContain("FLAGGED");
    expect(reviewView(makeReviewProps())).not.toContain("FLAGGED");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

CAUTION: do NOT run the full file yet — pre-implementation, `splitDiffRows` loops forever on an unknown row kind (an `ellipsis` entry matches neither the gap/ctx/h branches nor the del/add run consumers, so `i` never advances; a synchronous infinite loop that vitest cannot time out). Verify failure on the two safe tests instead:

Run: `npx vitest run test/render.review.test.ts -t "flagged"`
Expected: FAIL — no FLAGGED marker rendered.

Run: `npx vitest run test/render.review.test.ts -t "renderedPreview omits ellipsis"`
Expected: FAIL — the ellipsis text leaks into the rendered preview.

- [ ] **Step 3: Implement in `web/src/review.ts`**

Add next to `GAP_STYLE` (line 98):

```typescript
const ELLIPSIS_STYLE = "font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--fg-40);text-align:center;padding:6px 16px;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:6px 0";
```

`unifiedDiff` — add the ellipsis branch before the default return:

```typescript
export function unifiedDiff(entries: DiffEntry[]): string {
  const lines = entries.map((e) => {
    if (e.t === "gap") return `<div style="${GAP_STYLE}"></div>`;
    if (e.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}">${esc(e.s ?? "")}</div>`;
    return `<div style="${diffLineStyle(e.t)}">${diffPrefix(e.t)}${esc(e.s ?? "")}</div>`;
  }).join("");
  return `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;padding:8px 0">${lines}</div>`;
}
```

`splitDiffRows` — span ellipsis like ctx/h (line 123):

```typescript
    if (e.t === "ctx" || e.t === "h" || e.t === "ellipsis") {
```

`splitCellHtml` — add before the default return (line 146):

```typescript
  if (c.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}${borderRight}">${esc(c.text)}</div>`;
```

`renderedPreview` — widen the filter (line 163):

```typescript
  const blocks = entries.filter((e) => e.t !== "gap" && e.t !== "ellipsis").map((e) => {
```

Flagged marker — in `reviewCard`, next to the status badge (line 65):

```typescript
        ${statusBadge(it.badge, it.badgeColor)}${it.flagged ? statusBadge("FLAGGED", "var(--amber)") : ""}
```

and in `reviewDetail`'s header (line 218):

```typescript
          ${statusBadge(it.badge, it.badgeColor)}${it.flagged ? statusBadge("FLAGGED FOR REVIEW", "var(--amber)") : ""}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/render.review.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/review.ts test/render.review.test.ts
git commit -m "feat(web): diff viewer renders ellipsis rows; flagged marker for low-confidence proposals"
```

---

### Task 5: Wire Review — slices, loaders, real verdicts

Replace the mock-fed Review data path: two `Loadable` slices (`proposals`, `draftAdrs`), loaders keyed off `goReview`, props built via `reviewItemsFromReads`, loading/error via `notice()`, and the accept/reject buttons posting `promoteDoc`/`rejectDoc`/`ratifyAdr`/`rejectAdr` then refetching. Maintenance stays mock-fed until Task 8.

**Files:**
- Modify: `web/src/render.ts` (AppState, initialState, reviewProps, triageCounts, screenBody, new reviewScreen)
- Modify: `web/src/main.ts` (imports, loaders, goReview, reviewAccept/reviewReject)

**Interfaces:**
- Consumes: `listStagedProposals`, `listAdrs`, `promoteDoc`, `rejectDoc`, `ratifyAdr`, `rejectAdr` (api.ts); `reviewItemsFromReads`, `decodeReviewId` (triage-map.ts, Task 3); `Loadable` (render.ts).
- Produces: `AppState.proposals: Loadable<StagedProposal[]>`, `AppState.draftAdrs: Loadable<AdrRow[]>`; `slicePending(l: Loadable<unknown[]>): boolean` (module-private in render.ts, reused by Task 8's maintenanceScreen); loaders `loadProposals()` / `loadDraftAdrs()` (+`IfNeeded`) in main.ts that Task 8's `maintFile` refetch and Task 8's boot block also call.

- [ ] **Step 1: Add the slices to state (`web/src/render.ts`)**

Extend the api type import (line 6-8 area) so the slices are typed:

```typescript
import type { Me, StagedProposal } from "./api";
```

and extend the `@shared/rows` type import (line 7) with `AdrRow`:

```typescript
import type { FeedRow, DocRow, DocVersionRow, AdrRow } from "@shared/rows";
```

In `AppState` (line 30), REPLACE the triage mock-state block comment and `reviewDone` line — the block becomes:

```typescript
  // Triage surfaces (Review + Maintenance). Review is wired: two Loadable
  // slices below; *Done arrays remain only for the still-mock Maintenance.
  proposals: Loadable<StagedProposal[]>;
  draftAdrs: Loadable<AdrRow[]>;
  reviewFilter: ReviewFilter;
  reviewSel: string | null;
  reviewDiffView: DiffViewMode;
  unplacedDone: string[];
  identityDone: string[];
```

In `initialState()` (line 94-95), replace

```typescript
    reviewFilter: "all", reviewSel: null, reviewDiffView: "unified",
    reviewDone: [], unplacedDone: [], identityDone: [],
```

with

```typescript
    proposals: { status: "idle", data: [] },
    draftAdrs: { status: "idle", data: [] },
    reviewFilter: "all", reviewSel: null, reviewDiffView: "unified",
    unplacedDone: [], identityDone: [],
```

- [ ] **Step 2: Rebuild reviewProps + triageCounts + screenBody (`web/src/render.ts`)**

Add to the imports:

```typescript
import { reviewItemsFromReads } from "./triage-map";
```

Drop `MOCK_REVIEW_ITEMS` from the triage-mock import (line 17):

```typescript
import { MOCK_UNPLACED, MOCK_ASSIGN, MOCK_IDENTITY, MOCK_PEOPLE } from "./triage-mock";
```

Replace `reviewProps` (lines 113-120) with:

```typescript
export function reviewProps(s: AppState): ReviewProps {
  return {
    items: reviewItemsFromReads(s.proposals.data, s.draftAdrs.data),
    filter: s.reviewFilter,
    selectedId: s.reviewSel,
    diffView: s.reviewDiffView,
  };
}
```

Replace `triageCounts` (lines 136-143) with (review from slices; maintenance still mock until Task 8):

```typescript
/** Sidebar counts for the two triage entries — the lengths of the list reads. */
export function triageCounts(s: AppState): { review: number; maintenance: number } {
  return {
    review: s.proposals.data.length + s.draftAdrs.data.length,
    maintenance:
      MOCK_UNPLACED.filter((u) => !s.unplacedDone.includes(u.id)).length +
      MOCK_IDENTITY.filter((g) => !s.identityDone.includes(g.id)).length,
  };
}
```

Add above `screenBody` (near line 1207):

```typescript
/** A list slice that hasn't produced data yet (idle/loading with nothing cached). */
function slicePending(l: Loadable<unknown[]>): boolean {
  return (l.status === "idle" || l.status === "loading") && l.data.length === 0;
}

/** Review screen with slice-level loading/error states around the pure view. */
function reviewScreen(s: AppState): string {
  if (s.proposals.status === "error" || s.draftAdrs.status === "error") return notice("Couldn't load the review queue.");
  if (slicePending(s.proposals) || slicePending(s.draftAdrs)) return notice("Loading review queue&hellip;");
  return reviewView(reviewProps(s));
}
```

In `screenBody`, change the review case (line 1213):

```typescript
    case "review": return reviewScreen(s);
```

- [ ] **Step 3: Loaders + dispatch (`web/src/main.ts`)**

Extend the api import (lines 8-13):

```typescript
import {
  getFeed, listDocs, getDoc, search, getRoadmap, getMyDashboard,
  completeMilestone,
  listStagedProposals, listAdrs, promoteDoc, rejectDoc, ratifyAdr, rejectAdr,
  getMe, logout, mintMcpToken, adminBackfill,
  Unauthorized, NotFound, ApiError,
} from "./api";
import { decodeReviewId } from "./triage-map";
```

Trim the mock import (line 16) to:

```typescript
import { MOCK_UNPLACED, MOCK_IDENTITY, MOCK_PEOPLE } from "./triage-mock";
```

Add loaders after `loadRoadmapIfNeeded` (line 199):

```typescript
function loadProposals(): void {
  state.proposals = { status: "loading", data: state.proposals.data };
  rerender();
  listStagedProposals()
    .then((rows) => { state.proposals = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.proposals = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadProposalsIfNeeded(): void {
  if (state.proposals.status === "idle") loadProposals();
  else rerender();
}

function loadDraftAdrs(): void {
  state.draftAdrs = { status: "loading", data: state.draftAdrs.data };
  rerender();
  listAdrs("draft")
    .then((rows) => { state.draftAdrs = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.draftAdrs = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadDraftAdrsIfNeeded(): void {
  if (state.draftAdrs.status === "idle") loadDraftAdrs();
  else rerender();
}
```

Change the `goReview` case (line 297):

```typescript
    case "goReview": state.screen = "review"; loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); return;
```

Replace the mock `reviewAccept`/`reviewReject` block (lines 337-352) with:

```typescript
    case "reviewAccept":
    case "reviewReject": {
      if (!arg) return;
      const ref = decodeReviewId(arg);
      if (!ref) return;
      const accept = act === "reviewAccept";
      const op = ref.kind === "doc"
        ? (accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version))
        : (accept ? ratifyAdr(ref.id) : rejectAdr(ref.id));
      op.then(() => {
          state.reviewSel = null; // fall back to the first visible item
          flash(accept
            ? (ref.kind === "adr" ? "Ratified — the decision is now accepted" : "Promoted — the proposal is live; previous version kept")
            : "Rejected — parked, nothing changed");
          // Refetch the affected list — never locally decrement (badge drift is worse).
          if (ref.kind === "doc") loadProposals();
          else loadDraftAdrs();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Action failed");
        });
      return;
    }
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS (pure render + backend tests unaffected).

Run: `npm run typecheck`
Expected: clean — in particular no remaining `reviewDone` references anywhere (`grep -rn "reviewDone" web/src test` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add web/src/render.ts web/src/main.ts
git commit -m "feat(web): wire Review to real proposals + draft ADR reads and verdict writes"
```

---

### Task 6: Maintenance components — real assign vocabulary + identity confirm guard

Reshape the presentational Maintenance components to the real contract: `AssignOptions` becomes the four gate types × vocabulary targets (doc → section + optional space; feed → multi-select tags; adr/milestone → no target), `IdentityGroup` drops the fabricated `countNum`, and `personPicker` gains the two-step confirm that states the concrete effect. The surface stays mock-fed this task (state fields + UI-state dispatch move over; real fetches land in Task 8). TDD.

**Files:**
- Modify: `web/src/maintenance.ts`
- Modify: `web/src/triage-map.ts` (add `ASSIGN_OPTIONS`)
- Modify: `web/src/triage-mock.ts` (drop `MOCK_ASSIGN`; drop `countNum` from `MOCK_IDENTITY`)
- Modify: `web/src/render.ts` (AppState fields, maintenanceProps)
- Modify: `web/src/main.ts` (assign/identity UI-state dispatch)
- Modify: `test/render.review.test.ts`

**Interfaces:**
- Consumes: `pickRow`, `primaryBtn`, `avatarCircle`, `MONO_LABEL`, `esc` (ui.ts); `SECTIONS`, `TAGS` (`@shared/vocabulary`).
- Produces (Task 8 relies on these exact shapes):
  - `type AssignKind = "doc" | "adr" | "milestone" | "feed"`
  - `interface AssignOptions { kinds: { key: AssignKind; label: string }[]; sections: string[]; spaces: string[]; tags: string[] }`
  - `assignPanel(itemId: string, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string`
  - `unplacedRow(u: UnplacedItem, open: boolean, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string`
  - `interface IdentityGroup { id: string; login: string; meta: string; countLabel: string; sample: ActivitySample[] }` (NO `countNum`)
  - `personPicker(groupId: string, people: Person[], pick: string | null, confirming: boolean): string`
  - `identityCard(g: IdentityGroup, people: Person[], pick: string | null, confirming: boolean): string`
  - `interface MaintenanceProps { unplaced: UnplacedItem[]; assign: AssignOptions; assignOpen: string | null; assignKind: AssignKind | null; assignSection: string | null; assignSpace: string | null; assignTags: string[]; identity: IdentityGroup[]; people: Person[]; mapPicks: Record<string, string>; mapConfirm: string | null }`
  - `triage-map.ts` exports `const ASSIGN_OPTIONS: AssignOptions`
  - `AppState` gains `assignKind: AssignKind | null; assignSection: string | null; assignSpace: string | null; assignTags: string[]; mapConfirm: string | null` and loses `assignTarget`
  - dispatch actions: `maintAssignKind` / `maintAssignSection` / `maintAssignSpace` / `maintAssignTag` (toggle) / `identityPick` (resets `mapConfirm`) / `identityMap` (two-step)

- [ ] **Step 1: Write the failing tests**

In `test/render.review.test.ts`, extend the maintenance import (line 17):

```typescript
import { maintenanceView, assignPanel, personPicker, type MaintenanceProps, type UnplacedItem, type IdentityGroup } from "../web/src/maintenance";
```

Replace `makeGroup` and `makeMaintProps` (lines 259-278) with:

```typescript
function makeGroup(overrides: Partial<IdentityGroup> = {}): IdentityGroup {
  return {
    id: "mk-dev2", login: "mk-dev2", meta: "first seen 3w ago",
    countLabel: "recent activity",
    sample: [{ kind: "PR", text: "#412 Fix a thing", when: "2d ago" }],
    ...overrides,
  };
}

function makeMaintProps(overrides: Partial<MaintenanceProps> = {}): MaintenanceProps {
  return {
    unplaced: [makeUnplaced()],
    assign: {
      kinds: [
        { key: "doc", label: "Doc section" },
        { key: "adr", label: "Decision record" },
        { key: "milestone", label: "Roadmap note" },
        { key: "feed", label: "Feed update" },
      ],
      sections: ["reference", "context", "decisions"],
      spaces: ["sapling", "canopy"],
      tags: ["auth", "infra"],
    },
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    identity: [makeGroup()],
    people: [{ id: "maya-k", name: "maya-k", initials: "MA" }],
    mapPicks: {},
    mapConfirm: null,
    ...overrides,
  };
}
```

Update the two count-label assertions in "maintenanceView — populated" (line 286): replace

```typescript
    expect(html).toContain("1 login · 14 events waiting");
```

with

```typescript
    expect(html).toContain("1 login to match");
```

Replace the old "opens the assign panel with kinds, and targets gated on a kind pick" test (lines 297-304) with:

```typescript
  it("opens the assign panel and gates targets on a kind pick", () => {
    const closed = maintenanceView(makeMaintProps({ assignOpen: "u1" }));
    expect(closed).toContain("WHAT IS IT");
    expect(closed).toContain("Pick what kind of thing it is first.");
    const picked = maintenanceView(makeMaintProps({ assignOpen: "u1", assignKind: "doc" }));
    expect(picked).toContain("reference");
    expect(picked).not.toContain("Pick what kind of thing it is first.");
  });
```

Update the identity card test (line 306) — replace the `Maya Krishnan` expectation with the new fixture and add the accent-line copy:

```typescript
  it("renders the identity card pairing the activity sample with the person picker", () => {
    const html = maintenanceView(makeMaintProps());
    expect(html).toContain("mk-dev2");
    expect(html).toContain("#412 Fix a thing");
    expect(html).toContain("recent activity");
    expect(html).toContain("WHO IS THIS");
    expect(html).toContain("maya-k");
    expect(html).toContain("Map login");
  });
```

In the XSS describe (line 337), the hostile group uses `makeGroup({ login: ... })` — no change needed (countNum is gone from the factory).

Add the new describes at the end of the file:

```typescript
describe("assignPanel — per-type targets from the real vocabulary", () => {
  const assign = makeMaintProps().assign;

  it("prompts for a kind first", () => {
    expect(assignPanel("7", assign, null, null, null, [])).toContain("Pick what kind of thing it is first.");
  });

  it("doc kind offers sections plus an optional space, File it gated on section", () => {
    const noSection = assignPanel("7", assign, "doc", null, null, []);
    expect(noSection).toContain("reference");
    expect(noSection).toContain("decisions");
    expect(noSection).toContain("SPACE (OPTIONAL)");
    expect(noSection).not.toContain("cnpy-accentbtn"); // File it disabled
    const withSection = assignPanel("7", assign, "doc", "reference", null, []);
    expect(withSection).toContain("cnpy-accentbtn"); // File it enabled
  });

  it("feed kind offers multi-select tags and can file without one", () => {
    const html = assignPanel("7", assign, "feed", null, null, ["auth"]);
    expect(html).toContain("auth");
    expect(html).toContain("Tags are optional");
    expect(html).toContain("cnpy-accentbtn");
  });

  it("adr and milestone kinds need no target", () => {
    expect(assignPanel("7", assign, "adr", null, null, [])).toContain("No target needed");
    expect(assignPanel("7", assign, "milestone", null, null, [])).toContain("No target needed");
  });
});

describe("personPicker — two-step confirm guard", () => {
  const people = [{ id: "maya-k", name: "maya-k", initials: "MA" }];

  it("shows Map login and no effect-note before the first click", () => {
    const html = personPicker("mk-dev2", people, "maya-k", false);
    expect(html).toContain("Map login");
    expect(html).not.toContain("This attributes");
  });

  it("states the concrete effect and switches to Confirm mapping when confirming", () => {
    const html = personPicker("mk-dev2", people, "maya-k", true);
    expect(html).toContain("This attributes");
    expect(html).toContain("mk-dev2");
    expect(html).toContain("Confirm mapping");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/render.review.test.ts`
Expected: FAIL — type errors on the new prop shapes / missing behaviors.

- [ ] **Step 3: Reshape `web/src/maintenance.ts`**

Replace `AssignOptions` (lines 23-27) with:

```typescript
export type AssignKind = "doc" | "adr" | "milestone" | "feed";

/** The assign flow's REAL vocabulary: the four gate types, and the targets each
 *  accepts (doc → section + optional space; feed → optional multi-select tags;
 *  adr/milestone → no target). Values come from @shared/vocabulary via the
 *  mapping layer — components never hardcode them. */
export interface AssignOptions {
  kinds: { key: AssignKind; label: string }[];
  sections: string[];
  spaces: string[];
  tags: string[];
}
```

Replace `IdentityGroup` (lines 31-38) with:

```typescript
export interface IdentityGroup {
  id: string;          // the login — there is no numeric id; also the map route's path param
  login: string;
  meta: string;        // e.g. "first seen 3w ago"
  countLabel: string;  // accent line; the read returns samples, not a total — no fabricated count
  sample: ActivitySample[];
}
```

Replace `MaintenanceProps` (lines 42-51) with:

```typescript
export interface MaintenanceProps {
  unplaced: UnplacedItem[];
  assign: AssignOptions;
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  identity: IdentityGroup[];
  people: Person[];
  mapPicks: Record<string, string>;
  /** Login currently in the map confirm step (two-step guard) — null when none. */
  mapConfirm: string | null;
}
```

Replace `assignPanel` (lines 74-98) with:

```typescript
/** The expanded assign flow: pick what it is, then the real per-type target, then file it. */
export function assignPanel(itemId: string, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string {
  const kindChips = assign.kinds
    .map((k) => pickRow(esc(k.label), kind === k.key, "maintAssignKind", k.key))
    .join("");
  let targetCol: string;
  if (kind === null) {
    targetCol = `<div style="font-size:12.5px;color:var(--fg-40);padding:7px 0">Pick what kind of thing it is first.</div>`;
  } else if (kind === "doc") {
    const sectionRows = assign.sections.map((t) => pickRow(esc(t), section === t, "maintAssignSection", t)).join("");
    const spaceRows = assign.spaces.map((t) => pickRow(esc(t), space === t, "maintAssignSpace", t)).join("");
    targetCol = `<div style="display:flex;flex-direction:column;gap:5px">${sectionRows}</div>
      <div style="${MONO_LABEL};margin:12px 0 8px">SPACE (OPTIONAL)</div>
      <div style="display:flex;flex-direction:column;gap:5px">${spaceRows}</div>`;
  } else if (kind === "feed") {
    const tagRows = assign.tags.map((t) => pickRow(esc(t), tags.includes(t), "maintAssignTag", t)).join("");
    targetCol = `<div style="display:flex;flex-direction:column;gap:5px">${tagRows}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Tags are optional — pick any that apply.</div>`;
  } else {
    targetCol = `<div style="font-size:12.5px;color:var(--fg-40);padding:7px 0">No target needed — this files as a new ${kind === "adr" ? "decision draft" : "milestone proposal"}.</div>`;
  }
  const canFile = kind !== null && (kind !== "doc" || section !== null);
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:14px">
    <div style="display:grid;grid-template-columns:190px 1fr;gap:22px">
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHAT IS IT</div>
        <div style="display:flex;flex-direction:column;gap:5px">${kindChips}</div>
      </div>
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHERE IT GOES</div>
        ${targetCol}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      ${primaryBtn("File it", canFile, "maintFile", itemId)}
    </div>
  </div>`;
}
```

Update `unplacedRow`'s signature and panel call (lines 101, 121):

```typescript
export function unplacedRow(u: UnplacedItem, open: boolean, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string {
```

```typescript
    ${open ? assignPanel(u.id, assign, kind, section, space, tags) : ""}
```

Replace `personPicker` (lines 127-140) with:

```typescript
/** The "WHO IS THIS" column: pick a person, see the concrete effect, then confirm. */
export function personPicker(groupId: string, people: Person[], pick: string | null, confirming: boolean): string {
  const rows = people
    .map((p) => pickRow(
      `${avatarCircle(p.initials, 22)}<div style="font-size:13px;font-weight:500">${esc(p.name)}</div>`,
      pick === p.id,
      "identityPick",
      `${groupId}:${p.id}`,
      "padding:6px 9px",
    ))
    .join("");
  const pickedName = pick !== null ? (people.find((p) => p.id === pick)?.name ?? pick) : null;
  const confirmNote = confirming && pickedName !== null
    ? `<div style="border:1px solid var(--amber);border-radius:8px;padding:9px 11px;margin-top:10px;font-size:12px;line-height:1.5;color:var(--fg-70)">This attributes <b style="font-family:var(--mono)">${esc(groupId)}</b>&rsquo;s activity to <b>${esc(pickedName)}</b> — past and future captured events surface as theirs.</div>`
    : "";
  return `<div style="display:flex;flex-direction:column;gap:5px">${rows}</div>
    ${confirmNote}
    ${primaryBtn(confirming && pick !== null ? "Confirm mapping" : "Map login", pick !== null, "identityMap", groupId, "width:100%;margin-top:10px")}
    <div style="font-size:11px;color:var(--fg-40);margin-top:8px;line-height:1.5">All captured activity, past and future, flows into their view.</div>`;
}
```

Update `identityCard` (line 143) to thread the confirm flag and drop the countNum accent (line 156 keeps `countLabel`):

```typescript
export function identityCard(g: IdentityGroup, people: Person[], pick: string | null, confirming: boolean): string {
```

and its picker call (line 161):

```typescript
        ${personPicker(g.id, people, pick, confirming)}
```

Update `maintenanceView` (lines 168-190): replace the `identityCount` computation and the two `.map` calls:

```typescript
  const identityCount = p.identity.length === 0 ? ""
    : `${p.identity.length} login${p.identity.length === 1 ? "" : "s"} to match`;

  const unplaced = p.unplaced.length > 0
    ? p.unplaced.map((u) => {
        const open = p.assignOpen === u.id;
        return unplacedRow(u, open, p.assign, open ? p.assignKind : null, open ? p.assignSection : null, open ? p.assignSpace : null, open ? p.assignTags : []);
      }).join("")
    : maintEmpty("All clear", "Everything an agent produced found its place on its own.");

  const identity = p.identity.length > 0
    ? p.identity.map((g) => identityCard(g, p.people, p.mapPicks[g.id] ?? null, p.mapConfirm === g.id)).join("")
    : maintEmpty("Everyone is accounted for", "Every login in the activity stream is matched to a person.");
```

- [ ] **Step 4: Add `ASSIGN_OPTIONS` to `web/src/triage-map.ts`**

Add to the imports:

```typescript
import type { AssignOptions } from "./maintenance";
import { SECTIONS, TAGS } from "@shared/vocabulary";
```

Add at the end of the file:

```typescript
// ── Maintenance · assign vocabulary ──────────────────────────────────────────
/** The real assign options: gate types × @shared/vocabulary targets.
 *  'needs-triage' is the queue itself, never an assignable section. */
export const ASSIGN_OPTIONS: AssignOptions = {
  kinds: [
    { key: "doc", label: "Doc section" },
    { key: "adr", label: "Decision record" },
    { key: "milestone", label: "Roadmap note" },
    { key: "feed", label: "Feed update" },
  ],
  sections: SECTIONS.filter((s) => s !== "needs-triage"),
  spaces: ["sapling", "canopy"],
  tags: [...TAGS],
};
```

- [ ] **Step 5: Update the mock + state + dispatch to compile against the new shapes**

`web/src/triage-mock.ts`: delete the `MOCK_ASSIGN` export (lines 94-102) and drop `AssignOptions` from the type import (line 8); delete the `countNum: 14,`/`countNum: 3,` fields from both `MOCK_IDENTITY` entries and change both `countLabel` values to `"recent activity"`.

`web/src/render.ts`:
- Extend the maintenance import (line 16): `import { maintenanceView, type MaintenanceProps, type AssignKind } from "./maintenance";`
- Extend the triage-map import: `import { reviewItemsFromReads, ASSIGN_OPTIONS } from "./triage-map";`
- Trim the mock import: `import { MOCK_UNPLACED, MOCK_IDENTITY, MOCK_PEOPLE } from "./triage-mock";`
- In `AppState`, replace `assignKind: string | null; assignTarget: string | null;` (lines 60-61) with:

```typescript
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  mapConfirm: string | null;
```

(keep `assignOpen` and `mapPicks` as they are).
- In `initialState()`, replace `assignOpen: null, assignKind: null, assignTarget: null,` with:

```typescript
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    mapConfirm: null,
```

- Replace `maintenanceProps` (lines 122-133) with (still mock-fed):

```typescript
export function maintenanceProps(s: AppState): MaintenanceProps {
  return {
    unplaced: MOCK_UNPLACED.filter((u) => !s.unplacedDone.includes(u.id)),
    assign: ASSIGN_OPTIONS,
    assignOpen: s.assignOpen,
    assignKind: s.assignKind,
    assignSection: s.assignSection,
    assignSpace: s.assignSpace,
    assignTags: s.assignTags,
    identity: MOCK_IDENTITY.filter((g) => !s.identityDone.includes(g.id)),
    people: MOCK_PEOPLE,
    mapPicks: s.mapPicks,
    mapConfirm: s.mapConfirm,
  };
}
```

`web/src/main.ts` — replace the Maintenance dispatch cases (lines 406-450) with:

```typescript
    case "maintAssignToggle": {
      if (!arg) return;
      state.assignOpen = state.assignOpen === arg ? null : arg;
      state.assignKind = null;
      state.assignSection = null;
      state.assignSpace = null;
      state.assignTags = [];
      break;
    }
    case "maintAssignKind":
      if (arg === "doc" || arg === "adr" || arg === "milestone" || arg === "feed") {
        state.assignKind = arg;
        state.assignSection = null;
        state.assignSpace = null;
        state.assignTags = [];
      }
      break;
    case "maintAssignSection": if (arg) state.assignSection = arg; break;
    case "maintAssignSpace": if (arg) state.assignSpace = state.assignSpace === arg ? null : arg; break;
    case "maintAssignTag":
      if (arg) state.assignTags = state.assignTags.includes(arg) ? state.assignTags.filter((t) => t !== arg) : [...state.assignTags, arg];
      break;
    case "maintFile": {
      // Interim (mock-fed until Task 8 posts assignTriage): validate + close + flash.
      if (!arg || state.assignOpen !== arg || !state.assignKind) return;
      if (state.assignKind === "doc" && !state.assignSection) return;
      if (state.unplacedDone.includes(arg)) return;
      state.unplacedDone.push(arg);
      state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = [];
      flash("Filed (mock)");
      return;
    }
    case "maintDiscard": {
      if (!arg) return;
      const item = MOCK_UNPLACED.find((u) => u.id === arg);
      if (!item || state.unplacedDone.includes(arg)) return;
      state.unplacedDone.push(arg);
      if (state.assignOpen === arg) { state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = []; }
      flash(`Discarded — “${item.title}”`);
      return;
    }
    case "identityPick": {
      if (!arg) return;
      const sep = arg.indexOf(":");
      if (sep < 0) return;
      const login = arg.slice(0, sep);
      state.mapPicks = { ...state.mapPicks, [login]: arg.slice(sep + 1) };
      if (state.mapConfirm === login) state.mapConfirm = null; // changing the pick re-arms the confirm
      break;
    }
    case "identityMap": {
      if (!arg || !state.mapPicks[arg]) return;            // no auto-select: a person must be picked
      if (state.mapConfirm !== arg) { state.mapConfirm = arg; break; } // step 1: show the concrete effect
      state.mapConfirm = null;
      // Interim (mock-fed until Task 8 posts mapIdentity):
      if (state.identityDone.includes(arg)) return;
      state.identityDone.push(arg);
      flash("Mapped (mock)");
      return;
    }
```

- [ ] **Step 6: Run to verify everything passes**

Run: `npx vitest run test/render.review.test.ts`
Expected: PASS (new assignPanel/personPicker describes + updated maintenance describes).

Run: `npm run typecheck`
Expected: clean — no `assignTarget` or `countNum` references remain (`grep -rn "assignTarget\|countNum" web/src test` returns nothing).

- [ ] **Step 7: Commit**

```bash
git add web/src/maintenance.ts web/src/triage-map.ts web/src/triage-mock.ts web/src/render.ts web/src/main.ts test/render.review.test.ts
git commit -m "feat(web): maintenance components take the real assign vocabulary + identity confirm guard"
```

---

### Task 7: Mapping layer — Maintenance (unplaced + identity + people)

The pure derivations for the Maintenance surface: `NeedsTriageRow.raw` → title/snippet (JSON or free-form), the lossy-but-kept two-bucket reason chip with the verbatim gate reason in the note, `IdentityTask` → `IdentityGroup` (real event kinds, no fabricated count), and the person-picker source (the logins the app already knows). TDD in `test/triage-map.test.ts`.

**Files:**
- Modify: `web/src/triage-map.ts`
- Modify: `test/triage-map.test.ts`

**Interfaces:**
- Consumes: `NeedsTriageRow`, `IdentityTask` (from `./api`), `UnplacedItem`, `IdentityGroup`, `Person` (from `./maintenance`), `initialsOf`, `relTime` (from `./ui`).
- Produces (Task 8 relies on these exact signatures):
  - `unplacedFromRow(r: NeedsTriageRow): UnplacedItem` — `id` is `String(r.id)` (the write buttons `Number()` it back)
  - `identityFromTask(t: IdentityTask): IdentityGroup` — `id`/`login` are the login
  - `peopleFromLogins(logins: string[]): Person[]` — deduped, sorted, `id === name === login`

- [ ] **Step 1: Write the failing tests**

Append to `test/triage-map.test.ts` (extend the triage-map import with `unplacedFromRow, identityFromTask, peopleFromLogins, ASSIGN_OPTIONS`, and add `import type { NeedsTriageRow } from "@shared/rows";` and `import type { IdentityTask } from "../web/src/api";`):

```typescript
function makeTriageRow(overrides: Partial<NeedsTriageRow> = {}): NeedsTriageRow {
  return {
    id: 7,
    raw: JSON.stringify({ slug: "pool-sizing", title: "Notes on connection pool sizing", body: "Pool exhaustion under load traces to the reporting service.", section: "runbooks" }),
    reason: "out-of-vocab section: runbooks",
    source_author: "octo-agent",
    resolved: 0, created_at: "2026-07-03T10:00:00Z",
    resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null,
    ...overrides,
  };
}

describe("unplacedFromRow", () => {
  it("derives title and snippet from JSON raw and keeps the verbatim reason in the note", () => {
    const u = unplacedFromRow(makeTriageRow());
    expect(u.id).toBe("7");
    expect(u.title).toBe("Notes on connection pool sizing");
    expect(u.snippet).toContain("Pool exhaustion");
    expect(u.reason).toBe("AGENT FLAGGED");
    expect(u.reasonNote).toBe("out-of-vocab section: runbooks");
  });

  it("buckets low-confidence gate reasons into the LOW CONFIDENCE chip", () => {
    const u = unplacedFromRow(makeTriageRow({ reason: "low confidence doc proposal" }));
    expect(u.reason).toBe("LOW CONFIDENCE");
    expect(u.reasonNote).toBe("low confidence doc proposal");
  });

  it("falls back to the raw string itself for free-form items", () => {
    const u = unplacedFromRow(makeTriageRow({ raw: "remember to cap per-service pools" }));
    expect(u.title).toBe("remember to cap per-service pools");
    expect(u.snippet).toBe("remember to cap per-service pools");
  });

  it("builds meta from source_author + relative time, with an unknown fallback", () => {
    expect(unplacedFromRow(makeTriageRow()).meta).toContain("octo-agent");
    expect(unplacedFromRow(makeTriageRow({ source_author: null })).meta).toContain("unknown");
  });
});

function makeIdentityTask(overrides: Partial<IdentityTask> = {}): IdentityTask {
  return {
    login: "mk-dev2", first_seen: "2026-06-15T10:00:00Z",
    status: "pending", resolved_at: null, resolved_by: null,
    sample: [
      { semantic_key: "gh:pr:412:merged", event_type: "pr_merged", ref_number: 412, title: "Fix pagination", occurred_at: "2026-07-01T10:00:00Z" },
      { semantic_key: "gh:issue:398", event_type: "issue", ref_number: 398, title: null, occurred_at: null },
    ],
    ...overrides,
  };
}

describe("identityFromTask", () => {
  it("keys the group by login and uses the no-count copy", () => {
    const g = identityFromTask(makeIdentityTask());
    expect(g.id).toBe("mk-dev2");
    expect(g.login).toBe("mk-dev2");
    expect(g.countLabel).toBe("recent activity");
    expect(g.meta).toContain("first seen");
  });

  it("maps event kinds (pr_* → PR, issue → ISSUE) and composes #ref + title with a null fallback", () => {
    const g = identityFromTask(makeIdentityTask());
    expect(g.sample[0]).toMatchObject({ kind: "PR", text: "#412 Fix pagination" });
    expect(g.sample[1]).toMatchObject({ kind: "ISSUE", text: "#398 (no title)" });
  });
});

describe("ASSIGN_OPTIONS", () => {
  it("offers the four gate kinds and only real assignable sections", () => {
    expect(ASSIGN_OPTIONS.kinds.map((k) => k.key)).toEqual(["doc", "adr", "milestone", "feed"]);
    expect(ASSIGN_OPTIONS.sections).toEqual(["reference", "context", "decisions"]); // never needs-triage
    expect(ASSIGN_OPTIONS.spaces).toEqual(["sapling", "canopy"]);
    expect(ASSIGN_OPTIONS.tags).toContain("auth");
  });
});

describe("peopleFromLogins", () => {
  it("dedupes, drops empties, sorts, and derives initials", () => {
    const people = peopleFromLogins(["maya-k", "jonas-w", "maya-k", ""]);
    expect(people.map((p) => p.id)).toEqual(["jonas-w", "maya-k"]);
    expect(people[1]).toEqual({ id: "maya-k", name: "maya-k", initials: "MA" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/triage-map.test.ts`
Expected: FAIL — `unplacedFromRow` / `identityFromTask` / `peopleFromLogins` not exported.

- [ ] **Step 3: Implement in `web/src/triage-map.ts`**

Extend the api type import with `NeedsTriageRow, IdentityTask` and the maintenance import with `UnplacedItem, IdentityGroup, Person`. Then add:

```typescript
// ── Maintenance · Unplaced ───────────────────────────────────────────────────
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Derive the card fields from the stored gate payload: JSON of the gated item
 *  (DocProposal / AdrDraft / MilestoneProposal / FeedEntry) OR a free-form
 *  string for agent-flagged batch items. The two-bucket chip is a lossy
 *  convenience — the verbatim gate reason always rides in reasonNote. */
export function unplacedFromRow(r: NeedsTriageRow): UnplacedItem {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(r.raw);
    if (p !== null && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* free-form string raw — stays null */ }
  const str = (k: string): string | null => {
    const v = parsed?.[k];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const title = parsed
    ? str("title") ?? str("summary") ?? str("slug") ?? "Untitled item"
    : clip(r.raw, 80);
  const snippet = parsed
    ? str("body") ?? str("summary") ?? str("decision") ?? str("change_summary") ?? r.raw
    : r.raw;
  return {
    id: String(r.id),
    title,
    snippet: clip(snippet, 280),
    reason: r.reason.toLowerCase().startsWith("low confidence") ? "LOW CONFIDENCE" : "AGENT FLAGGED",
    meta: `${r.source_author ?? "unknown"} · ${relTime(r.created_at)}`,
    reasonNote: r.reason,
  };
}

// ── Maintenance · Identity ───────────────────────────────────────────────────
/** Real sample kinds are only pr_merged / pr_closed / issue — commits are never
 *  captured events. The read returns samples, not a total, so the accent line
 *  says "recent activity" instead of fabricating a count. */
export function identityFromTask(t: IdentityTask): IdentityGroup {
  return {
    id: t.login,
    login: t.login,
    meta: `first seen ${relTime(t.first_seen)}`,
    countLabel: "recent activity",
    sample: t.sample.map((s) => ({
      kind: s.event_type === "issue" ? "ISSUE" : "PR",
      text: `#${s.ref_number} ${s.title ?? "(no title)"}`,
      when: relTime(s.occurred_at),
    })),
  };
}

/** The person picker's source: the logins the app already knows (feed authors +
 *  the signed-in user). The picked value — a GitHub login — is posted as the map
 *  route's free-string `person`. */
export function peopleFromLogins(logins: string[]): Person[] {
  return [...new Set(logins.filter((l) => l.trim() !== ""))]
    .sort()
    .map((l) => ({ id: l, name: l, initials: initialsOf(l) }));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/triage-map.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/triage-map.ts test/triage-map.test.ts
git commit -m "feat(web): maintenance mapping layer — triage rows, identity tasks, people source"
```

---

### Task 8: Wire Maintenance — slices, loaders, real writes, boot-time counts

Swap the Maintenance data source from mock to the two remaining slices, post the real writes (`assignTriage` / `discardTriage` / `mapIdentity`) with refetch-after-verdict, and load all four triage lists at session boot so the sidebar badges are right on every screen. After this task nothing in `render.ts`/`main.ts` reads the mock module.

**Files:**
- Modify: `web/src/render.ts` (slices, maintenanceProps, triageCounts, maintenanceScreen, drop mock import)
- Modify: `web/src/main.ts` (loaders, goMaintenance, maintFile/maintDiscard/identityMap real writes, boot block, drop mock import)

**Interfaces:**
- Consumes: `listNeedsTriage`, `listIdentityTasks`, `assignTriage`, `discardTriage`, `mapIdentity`, `AssignTarget` (api.ts); `unplacedFromRow`, `identityFromTask`, `peopleFromLogins`, `ASSIGN_OPTIONS` (triage-map.ts); `slicePending`, `loadProposals`, `loadDraftAdrs` (Task 5); `loadFeedIfNeeded` (existing — the people-picker source).
- Produces: `AppState.needsTriage: Loadable<NeedsTriageRow[]>`, `AppState.identityTasks: Loadable<IdentityTask[]>`; `unplacedDone`/`identityDone` REMOVED from AppState; boot loads all four triage lists.

- [ ] **Step 1: Slices + props + counts (`web/src/render.ts`)**

Extend the api type import: `import type { Me, StagedProposal, IdentityTask } from "./api";` and the shared-rows import with `NeedsTriageRow` (line 7). Extend the triage-map import:

```typescript
import { reviewItemsFromReads, ASSIGN_OPTIONS, unplacedFromRow, identityFromTask, peopleFromLogins } from "./triage-map";
```

DELETE the triage-mock import (line 17) entirely.

In `AppState`, add below `draftAdrs` and remove `unplacedDone: string[]; identityDone: string[];`:

```typescript
  needsTriage: Loadable<NeedsTriageRow[]>;
  identityTasks: Loadable<IdentityTask[]>;
```

In `initialState()`, replace the `unplacedDone: [], identityDone: [],` remnants with:

```typescript
    needsTriage: { status: "idle", data: [] },
    identityTasks: { status: "idle", data: [] },
```

Replace `maintenanceProps` with:

```typescript
export function maintenanceProps(s: AppState): MaintenanceProps {
  return {
    unplaced: s.needsTriage.data.map(unplacedFromRow),
    assign: ASSIGN_OPTIONS,
    assignOpen: s.assignOpen,
    assignKind: s.assignKind,
    assignSection: s.assignSection,
    assignSpace: s.assignSpace,
    assignTags: s.assignTags,
    identity: s.identityTasks.data.map(identityFromTask),
    people: peopleFromLogins([...s.feedAuthors, ...(s.me ? [s.me.login] : [])]),
    mapPicks: s.mapPicks,
    mapConfirm: s.mapConfirm,
  };
}
```

Replace `triageCounts` with the final all-slices version:

```typescript
/** Sidebar counts for the two triage entries — the lengths of the four list reads. */
export function triageCounts(s: AppState): { review: number; maintenance: number } {
  return {
    review: s.proposals.data.length + s.draftAdrs.data.length,
    maintenance: s.needsTriage.data.length + s.identityTasks.data.length,
  };
}
```

Add next to `reviewScreen`:

```typescript
/** Maintenance screen with slice-level loading/error states around the pure view. */
function maintenanceScreen(s: AppState): string {
  if (s.needsTriage.status === "error" || s.identityTasks.status === "error") return notice("Couldn't load maintenance.");
  if (slicePending(s.needsTriage) || slicePending(s.identityTasks)) return notice("Loading maintenance&hellip;");
  return maintenanceView(maintenanceProps(s));
}
```

and switch `screenBody`'s maintenance case to `return maintenanceScreen(s);`.

- [ ] **Step 2: Loaders + real writes + boot (`web/src/main.ts`)**

Extend the api import with `listNeedsTriage, listIdentityTasks, assignTriage, discardTriage, mapIdentity, type AssignTarget`. DELETE the triage-mock import entirely.

Add loaders after `loadDraftAdrsIfNeeded`:

```typescript
function loadNeedsTriage(): void {
  state.needsTriage = { status: "loading", data: state.needsTriage.data };
  rerender();
  listNeedsTriage()
    .then((rows) => { state.needsTriage = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.needsTriage = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadNeedsTriageIfNeeded(): void {
  if (state.needsTriage.status === "idle") loadNeedsTriage();
  else rerender();
}

function loadIdentityTasks(): void {
  state.identityTasks = { status: "loading", data: state.identityTasks.data };
  rerender();
  listIdentityTasks()
    .then((rows) => { state.identityTasks = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.identityTasks = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadIdentityTasksIfNeeded(): void {
  if (state.identityTasks.status === "idle") loadIdentityTasks();
  else rerender();
}
```

Change `goMaintenance` (the feed load feeds the people picker):

```typescript
    case "goMaintenance": state.screen = "maintenance"; loadNeedsTriageIfNeeded(); loadIdentityTasksIfNeeded(); loadFeedIfNeeded(); return;
```

Replace the interim `maintFile` / `maintDiscard` / `identityMap` bodies from Task 6 with the real writes (the UI-state cases `maintAssignToggle`/`maintAssignKind`/`maintAssignSection`/`maintAssignSpace`/`maintAssignTag`/`identityPick` stay exactly as Task 6 wrote them):

```typescript
    case "maintFile": {
      if (!arg || state.assignOpen !== arg || !state.assignKind) return;
      if (state.assignKind === "doc" && !state.assignSection) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      const kind = state.assignKind;
      const target: AssignTarget = { type: kind };
      if (kind === "doc") {
        target.section = state.assignSection ?? undefined;
        target.space = state.assignSpace === "sapling" || state.assignSpace === "canopy" ? state.assignSpace : undefined;
      }
      if (kind === "feed") target.tags = state.assignTags;
      assignTriage(id, target)
        .then(() => {
          state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = [];
          flash("Filed — placed through the gate and resolved");
          loadNeedsTriage();
          if (kind === "doc") loadProposals();   // an assigned doc lands as a staged proposal
          if (kind === "adr") loadDraftAdrs();   // an assigned decision lands as a draft
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          // e.g. "cannot assign a free-form triage item; discard it instead" — verbatim from the gate
          flash(e instanceof ApiError ? e.message : "Could not file this item");
        });
      return;
    }
    case "maintDiscard": {
      if (!arg) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      if (state.assignOpen === arg) { state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = []; }
      discardTriage(id)
        .then(() => { flash("Discarded — parked, nothing changed"); loadNeedsTriage(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not discard");
        });
      return;
    }
```

```typescript
    case "identityMap": {
      if (!arg) return;
      const person = state.mapPicks[arg];
      if (!person) return;                                              // no auto-select: a person must be picked
      if (state.mapConfirm !== arg) { state.mapConfirm = arg; break; }  // step 1: show the concrete effect
      state.mapConfirm = null;
      mapIdentity(arg, person)
        .then(() => {
          flash(`Mapped — ${arg} → ${person}; their captured activity is now attributed`);
          loadIdentityTasks();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not map login");
        });
      return;
    }
```

In the boot block (line 519-525), after `loadMyWork();` add:

```typescript
      // Boot-time loads for the sidebar triage badges — the counts must be
      // right on every screen, not just after visiting Review/Maintenance.
      loadProposals();
      loadDraftAdrs();
      loadNeedsTriage();
      loadIdentityTasks();
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean — and `grep -rn "unplacedDone\|identityDone" web/src test` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add web/src/render.ts web/src/main.ts
git commit -m "feat(web): wire Maintenance to real triage + identity reads/writes; boot-time badge loads"
```

---

### Task 9: Delete the mock module + final verification

Nothing reads `triage-mock.ts` after Task 8 — delete it, prove nothing references it or the parked milestone-proposals queue, and run the full gate.

**Files:**
- Delete: `web/src/triage-mock.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a mock-free wired triage frontend.

- [ ] **Step 1: Delete the mock module**

```bash
git rm web/src/triage-mock.ts
```

- [ ] **Step 2: Prove nothing references the mock or leftover mock state**

Run: `grep -rn "triage-mock\|MOCK_" web/src test/ src/`
Expected: no output.

Run: `grep -rn "reviewDone\|unplacedDone\|identityDone\|assignTarget\|countNum" web/src test/`
Expected: no output.

- [ ] **Step 3: Prove the parked milestone-proposals queue is not rendered**

Run: `grep -n "MilestoneProposal\|listMilestoneProposals\|milestone-proposals" web/src/render.ts web/src/review.ts web/src/maintenance.ts web/src/main.ts web/src/triage-map.ts`
Expected: no output (the api.ts helpers remain, unused by the triage UI — that's intentional).

- [ ] **Step 4: Full gate**

Run: `npm test`
Expected: PASS (all files).

Run: `npm run typecheck`
Expected: clean.

Run: `npm run build:web`
Expected: Vite build succeeds into `web/dist`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(web): delete the triage mock module — every surface reads real data"
```


