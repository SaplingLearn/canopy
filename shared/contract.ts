import { z } from "zod";

export const Session = z.object({
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
  slug: z.string(),
  section: z.string(),
  title: z.string().optional(),          // session sends a real title when it has one
  body: z.string(),                      // markdown, or mermaid/d2 for diagrams
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
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

export const IngestPayload = z.object({
  session: Session,
  feed_entries: z.array(FeedEntry).default([]),
  doc_proposals: z.array(DocProposal).default([]),
  adr_drafts: z.array(AdrDraft).default([]),
  needs_triage: z.array(TriageItem).default([]),
  milestone_proposals: z.array(MilestoneProposal).default([]),
});

export type Session = z.infer<typeof Session>;
export type FeedEntry = z.infer<typeof FeedEntry>;
export type DocProposal = z.infer<typeof DocProposal>;
export type AdrDraft = z.infer<typeof AdrDraft>;
export type TriageItem = z.infer<typeof TriageItem>;
export type MilestoneProposal = z.infer<typeof MilestoneProposal>;
export type FocusUpdate = z.infer<typeof FocusUpdate>;
export type IngestPayload = z.infer<typeof IngestPayload>;
