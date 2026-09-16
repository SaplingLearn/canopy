// The sprints contract — the ONE place the Worker (src/) and the SPA (web/) agree
// on sprint shapes. Zod only: no DOM, no node built-ins, so it imports cleanly
// into both builds (web imports it type-only, so zod never enters the bundle).
//
// A sprint IS the old milestone row, renamed by 0025_sprints.sql — same table,
// same ids, new label plus `dates` / `summary` / `urgency` / `lead` / `domain`.
//
// TWO VOCABULARIES, ONE SEAM. The DB keeps its column names; the DTO speaks the
// product's words:
//   row.title       ↔ view.label
//   row.target_date ↔ view.due
//   row.status      → view.active   (derived: status === 'in_progress')
// Everything that crosses the wire as a REQUEST body (`SprintCreate`,
// `SprintActiveSet`, `SprintResourceAdd`) and the `update_plan` MCP input use the
// DTO vocabulary; only the writers in src/tools/ speak column names.
//
// Authority: sprints are human authored writes in the promote class — the admin
// plan write (`update_plan` → `write_plan`) and the cookie sprint routes. Nothing
// here is staged, nothing is agent-proposed (the milestone_proposals queue was
// dropped in 0025), and `status:'done'` is set by a person, never inferred.
// `lead` holds a person HANDLE (0023 identity root), never a GitHub login.

import { z } from "zod";
import type { TicketRow } from "./tickets";
import {
  SPRINT_URGENCIES, SPRINT_DOMAINS, SPRINT_STATUSES, SPRINT_RESOURCE_KINDS,
} from "./sprints-core";

// ── controlled vocabulary (must match the CHECK constraints in 0025_sprints.sql) ─
// Declared in the ZOD-FREE ./sprints-core so the SPA can iterate them as values
// (the New sprint panel's urgency segment / domain chips) without pulling zod
// into the browser bundle. Re-exported verbatim: `@shared/sprints` stays the one
// import path for the whole contract.

export {
  SPRINT_URGENCIES, SPRINT_DOMAINS, SPRINT_STATUSES, SPRINT_RESOURCE_KINDS,
} from "./sprints-core";

export const SprintUrgency = z.enum(SPRINT_URGENCIES);
export const SprintDomain = z.enum(SPRINT_DOMAINS);
export const SprintStatus = z.enum(SPRINT_STATUSES);
export const SprintResourceKind = z.enum(SPRINT_RESOURCE_KINDS);

export type SprintUrgency = z.infer<typeof SprintUrgency>;
export type SprintDomain = z.infer<typeof SprintDomain>;
export type SprintStatus = z.infer<typeof SprintStatus>;
export type SprintResourceKind = z.infer<typeof SprintResourceKind>;

// ── rows (the D1 columns, after 0025) ────────────────────────────────────────

export const SprintRow = z.object({
  id: z.number(),
  title: z.string(),                        // the DTO's `label`
  description: z.string().nullable(),       // markdown (rendered through renderMarkdown)
  target_date: z.string(),                  // the DTO's `due`; NOT NULL, '' when unscheduled
  status: SprintStatus,
  github_ref: z.string().nullable(),        // JSON: number (a GitHub milestone) | number[] (issues)
  created_at: z.string(),
  created_by: z.string(),                   // person handle
  updated_at: z.string().nullable(),
  phase: z.string().nullable(),             // coarse plan label ("Now", "Weeks 3-4", …) — 0012
  dates: z.string().nullable(),             // human date range shown on the card — 0025
  summary: z.string().nullable(),           // one line under the label — 0025
  urgency: SprintUrgency,                   // NOT NULL DEFAULT 'normal' — 0025
  lead: z.string().nullable(),              // person handle — 0025
  domain: SprintDomain.nullable(),          // 0025
});

export const SprintResourceRow = z.object({
  id: z.number(),
  sprint_id: z.number(),
  url: z.string(),
  kind: SprintResourceKind,
  label: z.string(),
  meta: z.string(),
});

export type SprintRow = z.infer<typeof SprintRow>;
export type SprintResourceRow = z.infer<typeof SprintResourceRow>;

// ── DTOs (what the routes return) ────────────────────────────────────────────

/** Computed progress — the sprint's OWN TICKETS, and nothing else.
 *  `total` = tickets whose `sprint_id` is this sprint; `closed` = those a person
 *  resolved (`done` or `declined`). A sprint with no tickets reads 0/0.
 *  The GitHub issues behind a sprint are a SEPARATE field (`SprintView.issues`)
 *  and are never folded in here. */
export interface SprintProgress {
  closed: number;
  total: number;
  pct: number;
}

/** The cached, event-derived GitHub issue counts for a sprint, resolved from its
 *  `github_ref` through the `sprint_progress` cache (written by the webhook and
 *  the cron backstop — never at render, never live GitHub). `null` when the
 *  sprint has no cache row. Shown ONLY in the Roadmap's Narrative spotlight,
 *  beside the issue chips; it never touches `progress`. */
export interface SprintIssueCounts {
  closed: number;
  total: number;
}

/** One sprint as every read surface exposes it: the row in the product's
 *  vocabulary, plus the two computed fields. */
export interface SprintView {
  id: number;
  label: string;                  // = row.title
  summary: string | null;
  description: string | null;     // markdown
  phase: string | null;
  dates: string | null;
  due: string | null;             // = row.target_date; null when unscheduled ('')
  status: SprintStatus;
  active: boolean;                // derived: status === 'in_progress'
  urgency: SprintUrgency;
  lead: string | null;            // person handle
  domain: SprintDomain | null;
  github_ref: string | null;
  created_at: string;
  created_by: string;
  updated_at: string | null;
  progress: SprintProgress;       // TICKETS only (done + declined over total)
  issues: SprintIssueCounts | null; // the GitHub half, from the sprint_progress cache
  members: string[];              // distinct assignee handles over the sprint's tickets
}

/** A ticket as the sprint screen lists it: the row, its nesting depth, and its
 *  assignee handles (the design's stacked avatars on a sprint's ticket rows).
 *  `depth: 1` = a child rendered under its root; a child whose parent is NOT in
 *  this sprint renders as a root (`depth: 0`). Populated in Phase 3. */
export type SprintTicketRow = TicketRow & { depth: 0 | 1; assignees: string[] };

/** A link shown in a sprint's Resources list: `sprint_resources` unioned with the
 *  ticket links inside the sprint, deduped by url. Populated in Phase 3. */
export interface SprintResourceView {
  url: string;
  kind: SprintResourceKind;
  label: string;
  meta: string;
}

export type SprintDetail = SprintView & {
  tickets: SprintTicketRow[];
  resources: SprintResourceView[];
};

// ── payloads (request bodies; the routes validate with these) ────────────────

export const SprintCreate = z.object({
  label: z.string().min(1),                       // the only required field
  dates: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  urgency: SprintUrgency.default("normal"),
  due: z.string().nullable().optional(),          // absent/null = unscheduled
  lead: z.string().nullable().optional(),
  domain: SprintDomain.nullable().optional(),
  phase: z.string().nullable().optional(),
});

export const SprintActiveSet = z.object({ active: z.boolean() });
export const SprintResourceAdd = z.object({ raw: z.string().min(1) });

export type SprintCreate = z.infer<typeof SprintCreate>;
export type SprintActiveSet = z.infer<typeof SprintActiveSet>;
export type SprintResourceAdd = z.infer<typeof SprintResourceAdd>;

// ── derivations ──────────────────────────────────────────────────────────────

/** `active` is DERIVED, never stored: a sprint is active exactly while it is
 *  in progress. `POST /sprints/:id/active` maps true → 'in_progress',
 *  false → 'upcoming'; 'done' is admin-only and is never active. */
export const sprintActive = (row: Pick<SprintRow, "status">): boolean => row.status === "in_progress";

/** Turn a row + its computed parts into the DTO every read surface returns.
 *  `progress` is the already-computed TICKET counts; `issues` the cached GitHub
 *  issue counts (or null); `members` the distinct assignee handles. `target_date`
 *  is NOT NULL in the schema, so an unscheduled sprint stores '' and surfaces as
 *  `due: null`. */
export function toSprintView(
  row: SprintRow,
  progress: { closed: number; total: number },
  members: string[] = [],
  issues: SprintIssueCounts | null = null
): SprintView {
  const { closed, total } = progress;
  return {
    id: row.id,
    label: row.title,
    summary: row.summary,
    description: row.description,
    phase: row.phase,
    dates: row.dates,
    due: row.target_date === "" ? null : row.target_date,
    status: row.status,
    active: sprintActive(row),
    urgency: row.urgency,
    lead: row.lead,
    domain: row.domain,
    github_ref: row.github_ref,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    progress: { closed, total, pct: total > 0 ? Math.round((100 * closed) / total) : 0 },
    issues,
    members,
  };
}
