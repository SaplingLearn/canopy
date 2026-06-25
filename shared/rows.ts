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
}

export interface DocVersionRow {
  id: number;
  slug: string;
  version: number;
  body: string;
  summary: string | null;
  status: "staged" | "promoted";
  confidence: string | null;
  created_at: string;
  created_by: string;
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
  status: "draft" | "ratified";
  confidence: string | null;
  created_at: string;
  created_by: string;
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
}

export interface UserRow {
  github_login: string;
  name: string | null;
  github_token: string | null;   // AES-GCM sealed GitHub OAuth token, or null
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
