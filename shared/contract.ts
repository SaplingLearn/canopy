import { z } from "zod";

export const Session = z.object({
  id: z.string(),                  // uuid minted by the writer; the replay key with item_index
  author: z.string(),   // advisory only — overwritten server-side from the authenticated principal
  ended_at: z.string(),            // ISO8601
  skill_version: z.string(),
});

export const FeedEntry = z.object({
  summary: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  artifacts: z.object({
    prs: z.array(z.string()).default([]),
    commits: z.array(z.string()).default([]),
    issues: z.array(z.number()).default([]),
  }),
});

export const DocProposal = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_/-]*$/),
  section: z.string(),
  title: z.string().optional(),          // session sends a real title when it has one
  body: z.string(),                      // markdown, or mermaid/d2 for diagrams
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
  space: z.enum(["sapling", "canopy"]).optional(),  // server defaults canopy on first creation
  base_version: z.number().optional(),   // the current_version the writer read before editing
  force: z.boolean().optional(),         // escape hatch: stage even if the body hash is unchanged
});

export const AdrDraft = z.object({
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  rationale: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const TriageItem = z.object({
  raw: z.string(),
  reason: z.string(),
});

export const MilestoneProposal = z.object({
  title: z.string(),
  target_date: z.string(),
  status: z.enum(["upcoming", "in_progress", "done"]),
  github_ref: z.union([z.number(), z.array(z.number())]).optional(),
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const FocusUpdate = z.object({
  working_on: z.string().min(1),
  next_up: z.string().optional(),
});

// ── Read-side query contract (Phase 1) ───────────────────────────────────────
// The stable seam for assembled, authority-flagged retrieval. RRF (Reciprocal
// Rank Fusion) is the future cross-source merge when Vectorize lands; this
// envelope does not change when that happens.
export const QueryRequest = z.object({
  q: z.string().default(""),
  types: z.array(z.enum(["doc", "decision", "feed"])).optional(), // default all
  section: z.string().optional(),
  space: z.enum(["sapling", "canopy"]).optional(),
  include_staged: z.boolean().optional(), // caller sets the default (MCP true, HTTP false)
  limit: z.number().optional(),           // full-body primary count (default 6)
  pointer_limit: z.number().optional(),   // ranked snippet count (default 20)
});

export const Authority = z.enum(["live", "staged_pending", "unpromoted", "draft"]);

export const QueryPrimary = z.object({
  type: z.enum(["doc", "decision", "feed"]),
  id: z.string(),
  title: z.string(),
  section: z.string().nullable(),
  space: z.string().nullable(),
  body: z.string(),                       // FULL current authoritative body
  authority: Authority,
  current_version: z.number().nullable(),
  pending_version: z.number().nullable(),
  staged_body: z.string().nullable(),     // only when include_staged AND a pending version exists
  confidence: z.string().nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  score: z.number(),                      // normalized so higher = better
});

export const QueryPointer = z.object({
  type: z.enum(["doc", "decision", "feed"]),
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  authority: Authority,
  score: z.number(),
});

export const QueryResult = z.object({
  primary: z.array(QueryPrimary),
  pointers: z.array(QueryPointer),
  meta: z.object({ engine: z.literal("fts5"), total: z.number() }),
});

export const IngestPayload = z.object({
  session: Session,
  feed_entries: z.array(FeedEntry).default([]),
  doc_proposals: z.array(DocProposal).default([]),
  adr_drafts: z.array(AdrDraft).default([]),
  needs_triage: z.array(TriageItem).default([]),
  milestone_proposals: z.array(MilestoneProposal).default([]),
  focus: FocusUpdate.optional(),   // the writer's end-of-session focus, reconciled as an upsert
});

export type Session = z.infer<typeof Session>;
export type FeedEntry = z.infer<typeof FeedEntry>;
export type DocProposal = z.infer<typeof DocProposal>;
export type AdrDraft = z.infer<typeof AdrDraft>;
export type TriageItem = z.infer<typeof TriageItem>;
export type MilestoneProposal = z.infer<typeof MilestoneProposal>;
export type FocusUpdate = z.infer<typeof FocusUpdate>;
export type IngestPayload = z.infer<typeof IngestPayload>;
export type QueryRequest = z.infer<typeof QueryRequest>;
export type Authority = z.infer<typeof Authority>;
export type QueryPrimary = z.infer<typeof QueryPrimary>;
export type QueryPointer = z.infer<typeof QueryPointer>;
export type QueryResult = z.infer<typeof QueryResult>;
