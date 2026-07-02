// One type per D1 table — the exact row shape returned by db helpers.
export interface SectionRow { name: string; description: string | null; }
export interface TagRow { tag: string; description: string | null; }

export interface DocRow {
  slug: string;
  section: string;
  title: string;
  body: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
  space: string;   // 'canopy' (tooling docs) | 'sapling' (product docs) — UI grouping, not access
}

export interface DocVersionRow {
  id: number;
  slug: string;
  version: number;
  body: string;
  summary: string | null;
  // 'rejected' is set only by Phase 3's reject route; Phase 2 never sets it.
  status: "staged" | "promoted" | "rejected";
  confidence: string | null;
  created_at: string;
  created_by: string;
  content_hash: string | null;   // SHA-256 of body — the dedupe key (0009)
  base_version: number | null;   // the version this edit was based on (0009)
  change_kind: "new" | "edit" | "rewrite" | null; // server-classified delta size (0009)
  low_confidence: number;        // 1 = staged-and-flagged (low-conf on an existing slug) (0009)
}

export interface FeedRow {
  id: number;
  author: string;
  summary: string;
  body: string | null;
  artifacts: string | null;
  created_at: string;
}

export interface AdrRow {
  id: number;
  title: string;
  context: string | null;
  decision: string | null;
  rationale: string | null;
  // 'rejected' is set only by Phase 3's reject route; Phase 2 never sets it.
  status: "draft" | "ratified" | "rejected";
  confidence: string | null;
  created_at: string;
  created_by: string;
  content_hash: string | null;   // SHA-256 of title+context+decision+rationale — dedupe key (0009)
}

export interface EntryTagRow {
  tag: string;
  entry_type: "doc" | "feed" | "adr";
  entry_id: string;
}

export interface NeedsTriageRow {
  id: number;
  raw: string;
  reason: string;
  source_author: string | null;
  resolved: number;
  created_at: string;
  // Phase 3 (0010) resolution audit. NULL until resolved; `resolved` flips to 1
  // when set. Soft only — a resolved item leaves the queue, it is never deleted.
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: "assigned" | "discarded" | null;
  assigned_ref: string | null;   // what an 'assigned' item materialized into (e.g. "doc:slug@2")
}

export interface UserRow {
  github_login: string;
  name: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user: string;
  created_at: string;
  expires_at: string;
}

export interface McpTokenRow {
  id: number;
  user: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

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
  phase: string | null;
}

export interface MilestoneProposalRow {
  id: number;
  title: string;
  target_date: string;
  status: string;
  github_ref: string | null;
  change_summary: string;
  confidence: string;
  staged_status: "staged" | "promoted" | "rejected";
  created_at: string;
  created_by: string;
  content_hash: string | null;   // SHA-256 of the proposed milestone fields — dedupe key (0009)
}

// The replay ledger (0009). One row per (session_id, item_index) the worker has
// seen; a re-POST of the same payload hits every row and drops as unchanged.
export interface ProcessedItemRow {
  session_id: string;
  item_index: number;
  item_type: "feed" | "doc" | "adr" | "milestone" | "triage" | "event";
  outcome: string;        // the gate's verdict (written | staged | triaged | unchanged)
  ref: string | null;     // what it became (e.g. "slug@2", a feed/adr id)
  created_at: string;
}

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
